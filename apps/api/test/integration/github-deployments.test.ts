import { randomInt } from 'node:crypto';
import type {
  App,
  Deployment,
  GitHubConnectionCapabilities,
  GitHubConnectionId,
  NodeId,
} from '@launchway/contracts';
import { generateId } from '@launchway/contracts';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { deployments, githubConnections, nodes, previews, users } from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { createDeploymentsMirror } from '../../src/modules/github/deployments-mirror.js';
import { secretContext } from '../../src/modules/github/providers.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { FakeAgentGateway } from '../support/fake-agent-gateway.js';
import { type FakeApp, FakeGitHub, sha, testPrivateKey } from '../support/fake-github.js';

const PUBLIC_URL = 'https://deploy.example.com';
const FULL = { contents: 'read', metadata: 'read', deployments: 'write', pull_requests: 'read' };
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('GitHub deployments and capabilities against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  const github = new FakeGitHub();
  const admin = testPrincipal('admin');
  const ghAppId = randomInt(100_000, 999_999_999);
  const installationId = randomInt(100_000, 999_999_999);
  const repoName = `mirrored-${ghAppId}`;
  const connectionId: GitHubConnectionId = generateId('gh');
  let fakeApp: FakeApp;
  let nodeId: NodeId;

  const capabilities = async (id: string, refresh = false) => {
    const res = await api.request(
      `/api/v1/github/connections/${id}/capabilities${refresh ? '?refresh=true' : ''}`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as GitHubConnectionCapabilities;
  };

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
      .values({ name: `ghd-node-${ghAppId}` })
      .returning({ id: nodes.id });
    nodeId = node?.id as NodeId;
    github.addRepo({ owner: 'octo', name: repoName, tags: { 'v1.0.0': sha('ghd-v1') } });
    // A GitHub App created before v0.2: read-only permissions, release events only.
    fakeApp = {
      id: ghAppId,
      slug: `launchway-${ghAppId}`,
      webhookSecret: 'whsec',
      privateKey: testPrivateKey(),
      installations: new Map([[installationId, { login: 'octo', type: 'User' }]]),
    };
    github.apps.set(ghAppId, fakeApp);
    await db.insert(githubConnections).values({
      id: connectionId,
      kind: 'app',
      name: 'Launchway',
      accountLogin: 'octo',
      accountType: 'User',
      appId: ghAppId,
      appSlug: fakeApp.slug,
      privateKeyEncrypted: deps.secrets.encrypt(
        fakeApp.privateKey,
        secretContext.privateKey(connectionId),
      ),
      webhookSecretEncrypted: deps.secrets.encrypt(
        'whsec',
        secretContext.webhookSecret(connectionId),
      ),
      installationId,
    });
  });

  afterAll(async () => {
    deps.lifecycle.beginShutdown();
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('reports what an existing GitHub App still has to grant, and caches it', async () => {
    const legacy = await capabilities(connectionId);
    expect(legacy).toMatchObject({
      connectionId,
      kind: 'app',
      deployments: false,
      pullRequests: false,
      events: ['release'],
      missing: ['deployments: write', 'pull_requests: read', 'event: push', 'event: pull_request'],
      pendingApproval: false,
      settingsUrl: `https://github.com/settings/apps/${fakeApp.slug}/permissions`,
      installationSettingsUrl: `https://github.com/settings/installations/${installationId}`,
      lastDeniedAt: null,
    });

    // The owner updates the app; the installation has not approved it yet. Cached until refresh.
    fakeApp.permissions = FULL;
    fakeApp.events = ['release', 'push', 'pull_request'];
    fakeApp.installationPermissions = { contents: 'read', metadata: 'read' };
    fakeApp.installationEvents = ['release'];
    const calls = github.calls.length;
    expect((await capabilities(connectionId)).checkedAt).toBe(legacy.checkedAt);
    expect(github.calls.length).toBe(calls);
    expect(await capabilities(connectionId, true)).toMatchObject({
      deployments: false,
      pendingApproval: true,
    });

    fakeApp.installationPermissions = FULL;
    fakeApp.installationEvents = ['release', 'push', 'pull_request'];
    expect(await capabilities(connectionId, true)).toMatchObject({
      deployments: true,
      pullRequests: true,
      events: ['pull_request', 'push', 'release'],
      missing: [],
      pendingApproval: false,
    });

    expect(
      (await api.request(`/api/v1/github/connections/${generateId('gh')}/capabilities`)).status,
    ).toBe(404);
    const viewer = createApp({ ...deps, auth: fixedAuth(null) });
    expect(
      (await viewer.request(`/api/v1/github/connections/${connectionId}/capabilities`)).status,
    ).toBe(401);
  });

  it('mirrors a deployment to GitHub and records its id', async () => {
    const mirror = createDeploymentsMirror(deps);
    const stop = mirror.start();
    const appRes = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: `Mirrored ${ghAppId}`,
        connectionId,
        repository: { owner: 'octo', name: repoName },
        nodeId,
      }),
    );
    expect(appRes.status).toBe(201);
    const app = (await appRes.json()) as App;
    expect(app.githubDeployments).toBe(true);

    const depRes = await api.request(
      `/api/v1/apps/${app.id}/deployments`,
      json('POST', { ref: 'v1.0.0' }),
    );
    expect(depRes.status).toBe(201);
    const deployment = (await depRes.json()) as Deployment;
    await mirror.idle();

    const mirrored = github.deployments.find((d) => d.repo === `octo/${repoName}`);
    expect(mirrored?.body).toMatchObject({
      ref: sha('ghd-v1'),
      environment: 'production',
      production_environment: true,
      transient_environment: false,
      auto_merge: false,
      required_contexts: [],
      description: `Launchway deployment ${deployment.id}`,
    });
    const [row] = await db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(row?.githubDeploymentId).toBe(mirrored?.id);

    // The agent reports success (simulated): GitHub gets the status with the log link.
    await db
      .update(deployments)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(deployments.id, deployment.id));
    deps.events.publish({
      topic: 'deployments',
      action: 'updated',
      resourceId: deployment.id,
      data: { appId: app.id, status: 'running' },
    });
    await mirror.idle();
    expect(mirrored?.statuses).toEqual([
      {
        state: 'success',
        description: 'Running',
        log_url: `${PUBLIC_URL}/apps/${app.id}?deployment=${deployment.id}`,
      },
    ]);

    // Opted out: nothing is sent for the next deployment.
    await api.request(`/api/v1/apps/${app.id}`, json('PATCH', { githubDeployments: false }));
    const before = github.deployments.length;
    await api.request(`/api/v1/apps/${app.id}/deployments`, json('POST', { ref: 'v1.0.0' }));
    await mirror.idle();
    expect(github.deployments.length).toBe(before);
    stop();
  });

  it('mirrors a preview deployment to its transient environment with the preview URL', async () => {
    const mirror = createDeploymentsMirror(deps);
    const stop = mirror.start();
    const appRes = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: `Previewed ${ghAppId}`,
        connectionId,
        repository: { owner: 'octo', name: repoName },
        nodeId,
      }),
    );
    expect(appRes.status).toBe(201);
    const app = (await appRes.json()) as App;
    const hostname = `previewed-${ghAppId}-pr-7.preview.example.com`;
    const [preview] = await db
      .insert(previews)
      .values({
        appId: app.id,
        prNumber: 7,
        prTitle: 'Try a thing',
        headSha: sha('ghd-pr-7'),
        branch: 'feat/thing',
        hostname,
        status: 'deploying',
      })
      .returning();
    const [row] = await db
      .insert(deployments)
      .values({
        appId: app.id,
        nodeId,
        ref: sha('ghd-pr-7'),
        commitSha: sha('ghd-pr-7'),
        trigger: 'preview',
        previewId: preview?.id ?? null,
        environmentName: 'preview/pr-7',
        createdAt: new Date(),
      })
      .returning();
    if (!row) throw new Error('no deployment');
    deps.events.publish({
      topic: 'deployments',
      action: 'created',
      resourceId: row.id,
      data: { appId: app.id, status: 'queued', previewId: row.previewId },
    });
    await mirror.idle();
    const mirrored = github.deployments.find(
      (d) => (d.body as { description?: string }).description === `Launchway deployment ${row.id}`,
    );
    expect(mirrored?.body).toMatchObject({
      ref: sha('ghd-pr-7'),
      environment: 'preview/pr-7',
      production_environment: false,
      transient_environment: true,
    });

    await db
      .update(deployments)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(deployments.id, row.id));
    deps.events.publish({
      topic: 'deployments',
      action: 'updated',
      resourceId: row.id,
      data: { appId: app.id, status: 'running', previewId: row.previewId },
    });
    await mirror.idle();
    expect(mirrored?.statuses).toEqual([
      expect.objectContaining({ state: 'success', environment_url: `https://${hostname}` }),
    ]);
    stop();
  });

  it('turns a refusal into the capability hint without failing the deployment', async () => {
    const mirror = createDeploymentsMirror(deps);
    const stop = mirror.start();
    const appRes = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: `Refused ${ghAppId}`,
        connectionId,
        repository: { owner: 'octo', name: repoName },
        nodeId,
      }),
    );
    const app = (await appRes.json()) as App;
    github.denyDeployments = true;
    const depRes = await api.request(
      `/api/v1/apps/${app.id}/deployments`,
      json('POST', { ref: 'v1.0.0' }),
    );
    expect(depRes.status).toBe(201);
    const deployment = (await depRes.json()) as Deployment;
    await mirror.idle();
    const [row] = await db.select().from(deployments).where(eq(deployments.id, deployment.id));
    expect(row).toMatchObject({ status: 'queued', githubDeploymentId: null });
    expect((await capabilities(connectionId)).lastDeniedAt).not.toBeNull();
    github.denyDeployments = false;
    stop();
  });

  it('probes a personal access token', async () => {
    const token = `github_pat_${String(ghAppId).padEnd(30, 'x')}`;
    github.addPat(token);
    const pat = (await (
      await api.request('/api/v1/github/connections/pat', json('POST', { name: 'PAT', token }))
    ).json()) as { id: string };
    expect(await capabilities(pat.id)).toMatchObject({
      kind: 'pat',
      deployments: true,
      pullRequests: true,
      events: [],
      missing: [],
      settingsUrl: 'https://github.com/settings/personal-access-tokens',
      installationSettingsUrl: null,
    });
    expect((await capabilities(pat.id)).probedRepository).toMatch(/^octo\//);

    github.patScopes.set(token, 'read:org');
    expect(await capabilities(pat.id, true)).toMatchObject({
      deployments: false,
      missing: ['deployments: write'],
    });
  });
});
