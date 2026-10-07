import { createHmac, randomInt } from 'node:crypto';
import type {
  App,
  AppManifestStart,
  Deployment,
  GitHubConnection,
  NodeId,
} from '@launchway/contracts';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import {
  apps,
  auditEvents,
  deployments,
  githubConnections,
  githubWebhookDeliveries,
  nodes,
  users,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { createReleasePoller } from '../../src/modules/github/poller.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { FakeAgentGateway } from '../support/fake-agent-gateway.js';
import { FakeGitHub, sha } from '../support/fake-github.js';

const PUBLIC_URL = 'https://deploy.example.com';
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('GitHub integration against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  const github = new FakeGitHub();
  const admin = testPrincipal('admin');
  const ghAppId = randomInt(100_000, 999_999_999);
  const installationId = randomInt(100_000, 999_999_999);
  const repoName = `repo-${ghAppId}`;
  let nodeId: NodeId;
  let connection: GitHubConnection;

  function webhook(
    event: string,
    payload: unknown,
    options: { secret?: string; delivery?: string } = {},
  ) {
    const body = JSON.stringify(payload);
    const secret = options.secret ?? github.apps.get(ghAppId)?.webhookSecret ?? '';
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': options.delivery ?? crypto.randomUUID(),
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': String(ghAppId),
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    };
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    const base = createTestDeps({ db, auth: fixedAuth(admin), agents: new FakeAgentGateway() });
    deps = { ...base, config: { ...base.config, publicUrl: PUBLIC_URL } };
    api = createApp(deps);
    await db.insert(users).values({
      id: admin.user.id,
      email: `admin-${ghAppId}@example.com`,
      name: 'Admin',
      role: 'admin',
    });
    const [node] = await db
      .insert(nodes)
      .values({ name: `gh-node-${ghAppId}` })
      .returning({ id: nodes.id });
    nodeId = node?.id as NodeId;
    github.addRepo({
      owner: 'octo',
      name: repoName,
      tags: { 'v1.0.0': sha('gh-v1'), 'v2.0.0': sha('gh-v2') },
      releases: [{ id: 1, tag: 'v1.0.0', publishedAt: '2026-01-01T00:00:00Z' }],
    });
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('creates and installs a GitHub App through the manifest flow', async () => {
    const start = await api.request(
      '/api/v1/github/connections/app-manifest/start',
      json('POST', { organization: 'acme' }),
    );
    expect(start.status).toBe(200);
    const flow = (await start.json()) as AppManifestStart;
    expect(flow.postUrl).toBe(
      `https://github.com/organizations/acme/settings/apps/new?state=${encodeURIComponent(flow.state)}`,
    );
    expect(flow.manifest).toMatchObject({
      name: 'Launchway (deploy.example.com)',
      redirect_url: `${PUBLIC_URL}/api/v1/github/connections/app-manifest/callback`,
      hook_attributes: { url: `${PUBLIC_URL}/api/v1/webhooks/github` },
    });
    const connectionId = /connections\/(gh_[^/]+)\/installation-callback/.exec(
      flow.manifest.setup_url,
    )?.[1];

    // Another user cannot complete it; a forged state is rejected.
    const other = createApp({ ...deps, auth: fixedAuth(testPrincipal('admin')) });
    const query = `code=code-${ghAppId}&state=${encodeURIComponent(flow.state)}`;
    expect(
      (await other.request(`/api/v1/github/connections/app-manifest/callback?${query}`)).status,
    ).toBe(403);
    expect(
      (
        await api.request(
          `/api/v1/github/connections/app-manifest/callback?code=x&state=forged.sig`,
        )
      ).status,
    ).toBe(400);

    github.addManifestCode(`code-${ghAppId}`, ghAppId);
    const callback = await api.request(`/api/v1/github/connections/app-manifest/callback?${query}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(
      `${PUBLIC_URL}/settings/github?connection=${connectionId}`,
    );

    const [row] = await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.appId, ghAppId));
    expect(row?.id).toBe(connectionId);
    expect(row?.privateKeyEncrypted).not.toContain('PRIVATE KEY');
    expect(row?.webhookSecretEncrypted).not.toContain(github.apps.get(ghAppId)?.webhookSecret);

    // The installation must belong to this app.
    const foreign = await api.request(
      `/api/v1/github/connections/${connectionId}/installation-callback?installation_id=1`,
    );
    expect(foreign.status).toBe(404);
    github.apps
      .get(ghAppId)
      ?.installations.set(installationId, { login: 'acme', type: 'Organization' });
    const installed = await api.request(
      `/api/v1/github/connections/${connectionId}/installation-callback?installation_id=${installationId}&setup_action=install`,
    );
    expect(installed.status).toBe(302);

    connection = (await (
      await api.request(`/api/v1/github/connections/${connectionId}`)
    ).json()) as GitHubConnection;
    expect(connection).toMatchObject({
      kind: 'app',
      account: { login: 'acme', type: 'Organization' },
      webhooksEnabled: true,
      app: {
        appId: ghAppId,
        installationId,
        installUrl: `https://github.com/apps/launchway-test-${ghAppId}/installations/new`,
      },
    });
    const list = (await (await api.request('/api/v1/github/connections')).json()) as {
      items: GitHubConnection[];
    };
    expect(list.items.map((c) => c.id)).toContain(connectionId);
    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, connectionId ?? ''));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'github-connection.create',
      'github-connection.install',
    ]);
  });

  it('lists repositories and releases and resolves refs through the installation', async () => {
    const repos = await api.request(
      `/api/v1/github/repos?connectionId=${connection.id}&query=${repoName}`,
    );
    expect(await repos.json()).toMatchObject({
      items: [{ fullName: `octo/${repoName}` }],
      nextCursor: null,
    });
    const releases = await api.request(
      `/api/v1/github/repos/octo/${repoName}/releases?connectionId=${connection.id}`,
    );
    expect(await releases.json()).toMatchObject({ items: [{ tagName: 'v1.0.0' }] });
    const ref = await api.request(
      `/api/v1/github/repos/octo/${repoName}/refs/v1.0.0?connectionId=${connection.id}`,
    );
    expect(await ref.json()).toEqual({ ref: 'v1.0.0', sha: sha('gh-v1'), kind: 'tag' });
    const missing = await api.request(
      `/api/v1/github/repos/octo/${repoName}/refs/nope?connectionId=${connection.id}`,
    );
    expect(missing.status).toBe(404);
  });

  it('verifies, dedupes and handles webhook deliveries', async () => {
    const appRes = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: `Hooked ${ghAppId}`,
        connectionId: connection.id,
        repository: { owner: 'Octo', name: repoName },
        nodeId,
        autoDeployReleases: true,
      }),
    );
    const app = (await appRes.json()) as App;

    expect(
      (await api.request('/api/v1/webhooks/github', webhook('ping', { zen: 'hi' }))).status,
    ).toBe(204);
    expect(
      (
        await api.request(
          '/api/v1/webhooks/github',
          webhook('ping', { zen: 'hi' }, { secret: 'wrong' }),
        )
      ).status,
    ).toBe(401);

    const release = {
      action: 'published',
      release: { tag_name: 'v2.0.0', draft: false, prerelease: false },
      repository: { name: repoName, owner: { login: 'octo' } },
      installation: { id: installationId },
    };
    const delivery = crypto.randomUUID();
    // GitHub failing while the tag is resolved: the delivery is forgotten so a redelivery retries.
    github.failRepoRequests = 1;
    expect(
      (await api.request('/api/v1/webhooks/github', webhook('release', release, { delivery })))
        .status,
    ).toBe(502);
    expect(
      await db
        .select()
        .from(githubWebhookDeliveries)
        .where(eq(githubWebhookDeliveries.deliveryId, delivery)),
    ).toEqual([]);
    expect(
      (await api.request('/api/v1/webhooks/github', webhook('release', release, { delivery })))
        .status,
    ).toBe(204);
    expect(
      (await api.request('/api/v1/webhooks/github', webhook('release', release, { delivery })))
        .status,
    ).toBe(204);
    const created = await db.select().from(deployments).where(eq(deployments.appId, app.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      ref: 'v2.0.0',
      commitSha: sha('gh-v2'),
      trigger: 'auto',
      status: 'queued',
    });
    const [stored] = await db
      .select()
      .from(githubWebhookDeliveries)
      .where(eq(githubWebhookDeliveries.deliveryId, delivery));
    expect(stored).toMatchObject({ event: 'release', connectionId: connection.id });

    const prerelease = {
      ...release,
      release: { ...release.release, tag_name: 'v3.0.0-rc.1', prerelease: true },
    };
    await api.request('/api/v1/webhooks/github', webhook('release', prerelease));
    expect(await db.select().from(deployments).where(eq(deployments.appId, app.id))).toHaveLength(
      1,
    );

    const uninstall = {
      action: 'deleted',
      installation: { id: installationId, account: { login: 'acme', type: 'Organization' } },
    };
    expect(
      (await api.request('/api/v1/webhooks/github', webhook('installation', uninstall))).status,
    ).toBe(204);
    const after = (await (
      await api.request(`/api/v1/github/connections/${connection.id}`)
    ).json()) as GitHubConnection;
    expect(after.app?.installationId).toBeNull();
    expect(after.webhooksEnabled).toBe(false);
  });

  it('polls releases for PAT connections and deploys new ones once', async () => {
    const token = `ghp_${String(ghAppId).padEnd(36, 'z')}`;
    github.addPat(token);
    const patRes = await api.request(
      '/api/v1/github/connections/pat',
      json('POST', { name: 'PAT', token }),
    );
    expect(patRes.status).toBe(201);
    const pat = (await patRes.json()) as GitHubConnection;
    const polledRepo = github.addRepo({
      owner: 'octo',
      name: `polled-${ghAppId}`,
      tags: { 'v1.0.0': sha('p1'), 'v1.1.0': sha('p2') },
      releases: [{ id: 1, tag: 'v1.0.0', publishedAt: '2020-01-01T00:00:00Z' }],
    });
    const appRes = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: `Polled ${ghAppId}`,
        connectionId: pat.id,
        repository: { owner: 'octo', name: polledRepo.name },
        nodeId,
        autoDeployReleases: true,
      }),
    );
    const app = (await appRes.json()) as App;
    const poller = createReleasePoller(deps);

    await poller.tick();
    expect(await db.select().from(deployments).where(eq(deployments.appId, app.id))).toHaveLength(
      0,
    );

    polledRepo.releases?.push({
      id: 2,
      tag: 'v1.1.0',
      publishedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await poller.tick();
    await poller.tick();
    const polled = await db
      .select()
      .from(deployments)
      .where(and(eq(deployments.appId, app.id), eq(deployments.ref, 'v1.1.0')));
    expect(polled).toHaveLength(1);
    expect(polled[0]?.trigger).toBe('auto');
    const deployment = (await (
      await api.request(`/api/v1/deployments/${polled[0]?.id}`)
    ).json()) as Deployment;
    expect(deployment.triggeredBy).toBeNull();

    // Deleting a connection is refused while apps use it.
    expect((await api.request(`/api/v1/github/connections/${pat.id}`, json('DELETE'))).status).toBe(
      409,
    );
    await db.delete(apps).where(eq(apps.id, app.id));
    expect((await api.request(`/api/v1/github/connections/${pat.id}`, json('DELETE'))).status).toBe(
      204,
    );
    expect((await api.request(`/api/v1/github/connections/${pat.id}`)).status).toBe(404);
  });
});
