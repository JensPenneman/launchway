import { createHmac, randomBytes, randomInt } from 'node:crypto';
import {
  type App,
  type Deployment,
  type DeploymentId,
  generateId,
  type NodeId,
} from '@launchway/contracts';
import { and, asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import {
  auditEvents,
  deploymentLogLines,
  deployments,
  githubConnections,
  nodes,
  settings,
  users,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import {
  createDispatcher,
  IMAGE_RETRY_LIMIT,
  SUPERSEDED_WHILE_WAITING_MESSAGE,
} from '../../src/modules/deployments/dispatcher.js';
import { createDeploymentSink, MANUAL_IMAGE_HINT } from '../../src/modules/deployments/sink.js';
import { secretContext } from '../../src/modules/github/providers.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { FakeAgentGateway } from '../support/fake-agent-gateway.js';
import { FakeGitHub, sha, testPrivateKey } from '../support/fake-github.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

let counter = 0;
const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

async function until(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('auto-deploys and image retries against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  const github = new FakeGitHub();
  const gateway = new FakeAgentGateway();
  const admin = testPrincipal('admin');
  const ghAppId = randomInt(100_000, 999_999_999);
  const installationId = randomInt(100_000, 999_999_999);
  const webhookSecret = randomBytes(16).toString('hex');
  const connectionId = generateId('gh');
  let nodeId: NodeId;

  function webhook(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': crypto.randomUUID(),
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': String(ghAppId),
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
      },
      body,
    };
  }

  async function deliver(event: string, payload: unknown): Promise<void> {
    const res = await api.request('/api/v1/webhooks/github', webhook(event, payload));
    expect(res.status).toBe(204);
  }

  async function createTestApp(extra: Record<string, unknown> = {}): Promise<App> {
    const repo = github.addRepo({
      owner: 'octo',
      name: unique('repo'),
      tags: {
        'v1.0.0': sha('v1.0.0'),
        'v1.1.0': sha('v1.1.0'),
        'v2.0.0': sha('v2.0.0'),
        'v3.0.0-rc.1': sha('v3.0.0-rc.1'),
      },
      branches: { main: sha('main') },
    });
    const res = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: unique('App'),
        connectionId,
        repository: { owner: repo.owner, name: repo.name },
        nodeId,
        ...extra,
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as App;
  }

  const appRepository = (app: App) => ({
    name: app.repository.name,
    owner: { login: app.repository.owner },
  });

  async function rowsOf(appId: string) {
    return db
      .select()
      .from(deployments)
      .where(eq(deployments.appId, appId as App['id']))
      .orderBy(asc(deployments.createdAt));
  }

  async function row(id: DeploymentId) {
    const [found] = await db.select().from(deployments).where(eq(deployments.id, id));
    if (!found) throw new Error(`no deployment ${id}`);
    return found;
  }

  const sentCount = (id: DeploymentId) =>
    gateway.deployed.filter((d) => d.payload.deploymentId === id).length;

  /** Plays an agent attempt that fails because the image does not exist yet. */
  async function failWithMissingImage(id: DeploymentId) {
    const sink = createDeploymentSink(deps);
    await sink.onProgress(nodeId, { deploymentId: id, status: 'cloning' });
    await sink.onProgress(nodeId, { deploymentId: id, status: 'building' });
    await sink.onLog(nodeId, {
      deploymentId: id,
      lines: [
        {
          seq: 0,
          timestamp: new Date().toISOString(),
          stream: 'stderr',
          line: 'Error response from daemon: manifest unknown',
        },
      ],
    });
    await sink.onResult(nodeId, {
      deploymentId: id,
      outcome: 'failed',
      error: {
        code: 'internal-error',
        message: 'Image not found in the registry (exit 18): docker compose pull',
        retryable: true,
      },
      reason: 'image-not-found',
    });
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    deps = createTestDeps({ db, auth: fixedAuth(admin), agents: gateway });
    api = createApp(deps);
    await db.insert(users).values({
      id: admin.user.id,
      email: `${unique('admin')}@example.com`,
      name: 'Admin',
      role: 'admin',
    });
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    const [node] = await db
      .insert(nodes)
      .values({ name: unique('node'), status: 'online', lanIp: '192.168.1.40' })
      .returning({ id: nodes.id });
    nodeId = node?.id as NodeId;
    gateway.connect(nodeId);

    github.apps.set(ghAppId, {
      id: ghAppId,
      slug: `launchway-auto-${ghAppId}`,
      webhookSecret,
      privateKey: testPrivateKey(),
      installations: new Map([[installationId, { login: 'octo', type: 'User' }]]),
    });
    await db.insert(githubConnections).values({
      id: connectionId,
      kind: 'app',
      name: unique('GitHub App'),
      accountLogin: 'octo',
      accountType: 'User',
      appId: ghAppId,
      appSlug: `launchway-auto-${ghAppId}`,
      privateKeyEncrypted: deps.secrets.encrypt(
        testPrivateKey(),
        secretContext.privateKey(connectionId),
      ),
      webhookSecretEncrypted: deps.secrets.encrypt(
        webhookSecret,
        secretContext.webhookSecret(connectionId),
      ),
      installationId,
    });
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('retries an automatic deployment until its image exists, then gives up', async () => {
    const app = await createTestApp({ autoDeployReleases: true });
    await deliver('release', {
      action: 'published',
      release: { tag_name: 'v1.0.0', draft: false, prerelease: false },
      repository: appRepository(app),
    });
    await until(async () => (await rowsOf(app.id)).length === 1);
    const [created] = await rowsOf(app.id);
    const id = created?.id as DeploymentId;
    await until(async () => sentCount(id) === 1);
    expect(created).toMatchObject({ trigger: 'auto', retryCount: 0 });

    const dispatcher = createDispatcher(deps);
    for (let attempt = 1; attempt <= IMAGE_RETRY_LIMIT; attempt += 1) {
      const before = Date.now();
      await failWithMissingImage(id);
      const waiting = await row(id);
      expect(waiting).toMatchObject({
        status: 'queued',
        retryCount: attempt,
        failureReason: 'image-not-found',
        startedAt: null,
        finishedAt: null,
      });
      const delay = Math.min(2 ** (attempt - 1), 15) * 60_000;
      const due = waiting.nextAttemptAt?.getTime() ?? 0;
      expect(due).toBeGreaterThanOrEqual(before + delay);
      expect(due).toBeLessThan(Date.now() + delay + 1_000);
      expect(waiting.statusMessage).toBe(
        `Waiting for the image: retry ${attempt} at ${waiting.nextAttemptAt?.toISOString()}`,
      );

      // Not dispatched before it is due, then sent again.
      await dispatcher.tick(new Date(due - 1_000));
      expect(sentCount(id)).toBe(attempt);
      await dispatcher.tick(new Date(due + 1_000));
      expect(sentCount(id)).toBe(attempt + 1);
      const claimed = await row(id);
      expect(claimed.startedAt).not.toBeNull();
      expect(claimed.nextAttemptAt).toBeNull();
    }

    const api1 = (await (await api.request(`/api/v1/deployments/${id}`)).json()) as Deployment;
    expect(api1).toMatchObject({
      status: 'queued',
      retryCount: IMAGE_RETRY_LIMIT,
      failureReason: 'image-not-found',
      nextAttemptAt: null,
    });

    await failWithMissingImage(id);
    const failed = await row(id);
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: 'image-not-found',
      retryCount: IMAGE_RETRY_LIMIT,
      nextAttemptAt: null,
    });
    expect(failed.statusMessage).toMatch(
      /^Gave up after 7 retries over 60 minutes: the image still does not exist in the registry\.\nImage not found/,
    );

    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, id));
    expect(audits.filter((a) => a.action === 'deployment.retry')).toHaveLength(IMAGE_RETRY_LIMIT);
    expect(audits.at(-1)?.action).toBe('deployment.fail');
    const notes = await db
      .select({ line: deploymentLogLines.line })
      .from(deploymentLogLines)
      .where(and(eq(deploymentLogLines.deploymentId, id), eq(deploymentLogLines.stream, 'system')));
    expect(
      notes.some((n) =>
        /^Image not found in the registry\. Waiting for the image: retry 1 at \S+\.$/.test(n.line),
      ),
    ).toBe(true);
  });

  it('fails a manual deployment at once and suggests deploying again', async () => {
    const app = await createTestApp();
    const res = await api.request(
      `/api/v1/apps/${app.id}/deployments`,
      json('POST', { ref: 'v1.0.0' }),
    );
    expect(res.status).toBe(201);
    const deployment = (await res.json()) as Deployment;
    expect(sentCount(deployment.id)).toBe(1);
    await failWithMissingImage(deployment.id);
    const failed = await row(deployment.id);
    expect(failed).toMatchObject({
      status: 'failed',
      retryCount: 0,
      failureReason: 'image-not-found',
    });
    expect(failed.statusMessage?.startsWith(`${MANUAL_IMAGE_HINT}\n`)).toBe(true);
  });

  it('cancels a waiting retry once a newer deployment of the app starts', async () => {
    const app = await createTestApp({ autoDeployReleases: true });
    await deliver('release', {
      action: 'published',
      release: { tag_name: 'v1.0.0', draft: false, prerelease: false },
      repository: appRepository(app),
    });
    await until(async () => (await rowsOf(app.id)).length === 1);
    const waitingId = (await rowsOf(app.id))[0]?.id as DeploymentId;
    await until(async () => sentCount(waitingId) === 1);
    await failWithMissingImage(waitingId);
    expect((await row(waitingId)).status).toBe('queued');

    const res = await api.request(
      `/api/v1/apps/${app.id}/deployments`,
      json('POST', { ref: 'v1.1.0' }),
    );
    const newer = (await res.json()) as Deployment;
    expect(sentCount(newer.id)).toBe(1);
    expect(await row(waitingId)).toMatchObject({
      status: 'cancelled',
      statusMessage: SUPERSEDED_WHILE_WAITING_MESSAGE,
      nextAttemptAt: null,
    });
  });

  it('deploys releases published from drafts, opted-in prereleases and branch pushes', async () => {
    const app = await createTestApp({ autoDeployReleases: true, autoDeployBranch: 'main' });
    expect(app).toMatchObject({ autoDeployPrereleases: false, autoDeployBranch: 'main' });
    const repository = appRepository(app);
    const release = (
      action: string,
      tag: string,
      flags: { draft?: boolean; prerelease?: boolean } = {},
      changes?: unknown,
    ) => ({
      action,
      release: { tag_name: tag, draft: false, prerelease: false, ...flags },
      ...(changes ? { changes } : {}),
      repository,
    });
    const refs = async () => (await rowsOf(app.id)).map((r) => [r.ref, r.trigger]);

    // release-please creates a draft; nothing deploys until CI publishes it.
    await deliver('release', release('created', 'v2.0.0', { draft: true }));
    await deliver('release', release('edited', 'v2.0.0', { draft: true }, { body: { from: '' } }));
    expect(await refs()).toEqual([]);

    // Publishing the draft (GitHub sends published and released, possibly edited too).
    await Promise.all([
      deliver('release', release('published', 'v2.0.0')),
      deliver('release', release('released', 'v2.0.0')),
      deliver('release', release('edited', 'v2.0.0', {}, { draft: { from: true } })),
    ]);
    await until(async () => (await refs()).length === 1);
    expect(await refs()).toEqual([['v2.0.0', 'auto']]);

    // Prereleases need the opt-in.
    await deliver('release', release('published', 'v3.0.0-rc.1', { prerelease: true }));
    expect(await refs()).toHaveLength(1);
    const patched = await api.request(
      `/api/v1/apps/${app.id}`,
      json('PATCH', { autoDeployPrereleases: true }),
    );
    expect(patched.status).toBe(200);
    await deliver('release', release('published', 'v3.0.0-rc.1', { prerelease: true }));
    await until(async () => (await refs()).length === 2);

    // Pushes to the configured branch deploy the pushed commit, once.
    const pushed = sha('push-1');
    const push = (ref: string, after = pushed) => ({ ref, after, deleted: false, repository });
    await deliver('push', push('refs/heads/main'));
    await deliver('push', push('refs/heads/main'));
    await deliver('push', push('refs/heads/feature'));
    await deliver('push', push('refs/tags/v9.0.0'));
    await until(async () => (await refs()).length === 3);
    const rows = await rowsOf(app.id);
    expect(rows.at(-1)).toMatchObject({ ref: 'main', commitSha: pushed, trigger: 'auto' });
    expect(rows).toHaveLength(3);
  });
});
