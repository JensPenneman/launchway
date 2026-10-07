import { createHmac, randomInt, randomUUID } from 'node:crypto';
import {
  type AppId,
  type DnsProviderAccount,
  generateId,
  type NodeId,
  type Preview,
  type PreviewPage,
  previewAgentAppId,
} from '@launchway/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import {
  apps,
  auditEvents,
  deployments,
  domains,
  githubConnections,
  nodes,
  previews,
  routes,
  settings,
  users,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { dnsProviders } from '../../src/modules/dns/providers/registry.js';
import { secretContext } from '../../src/modules/github/providers.js';
import { createPreviewsService } from '../../src/modules/previews/service.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { FakeAgentGateway } from '../support/fake-agent-gateway.js';
import { FakeGitHub, sha, testPrivateKey } from '../support/fake-github.js';
import { createMemoryDnsState, memoryProviderDefinition } from '../support/memory-dns.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('pull request previews against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  const agents = new FakeAgentGateway();
  const github = new FakeGitHub();
  const admin = testPrincipal('admin');
  const suffix = randomUUID().slice(0, 8);
  const zoneName = `p${suffix}.example`;
  const kind = `mem-prv-${suffix}`;
  const dns = createMemoryDnsState([{ externalId: 'z-prv', name: zoneName }], 'prv-token');
  const anchor = `home.${zoneName}`;
  const base = `preview.${zoneName}`;
  const ghAppId = randomInt(100_000, 999_999_999);
  const webhookSecret = `whsec-${suffix}`;
  const repoName = `site-${suffix}`;
  const slug = `site${suffix}`;
  let nodeId: NodeId;
  let appId: AppId;
  let original: Partial<typeof settings.$inferInsert> | undefined;

  function webhook(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': randomUUID(),
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': String(ghAppId),
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
      },
      body,
    };
  }

  function pullRequest(
    action: string,
    number: number,
    head: string,
    options: {
      fork?: boolean;
      merged?: boolean;
      bot?: boolean;
      labels?: string[];
      label?: string;
    } = {},
  ) {
    const fullName = `octo/${repoName}`;
    return {
      action,
      number,
      ...(options.label ? { label: { name: options.label } } : {}),
      pull_request: {
        title: `Change ${number}`,
        state: action === 'closed' ? 'closed' : 'open',
        merged: options.merged ?? false,
        user: options.bot
          ? { login: 'dependabot[bot]', type: 'Bot' }
          : { login: 'octocat', type: 'User' },
        labels: (options.labels ?? []).map((name) => ({ name })),
        head: {
          ref: `feature/${number}`,
          sha: head,
          repo: { full_name: options.fork ? `forker/${repoName}` : fullName },
        },
        base: { repo: { full_name: fullName } },
      },
      repository: { name: repoName, owner: { login: 'octo' } },
    };
  }

  async function previewOf(number: number) {
    const [row] = await db
      .select()
      .from(previews)
      .where(and(eq(previews.appId, appId), eq(previews.prNumber, number)));
    return row;
  }

  async function auditActions(id: string): Promise<string[]> {
    const rows = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, id));
    return rows.map((row) => row.action).sort();
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    dnsProviders.register(memoryProviderDefinition(kind, dns));
    deps = createTestDeps({ db, auth: fixedAuth(admin), agents });
    api = createApp(deps);
    await db.insert(users).values({
      id: admin.user.id,
      email: `admin-${suffix}@example.com`,
      name: 'Admin',
      role: 'admin',
    });
    const [node] = await db
      .insert(nodes)
      .values({ name: `prv-node-${suffix}` })
      .returning({ id: nodes.id });
    nodeId = node?.id as NodeId;
    agents.connect(nodeId);

    // A GitHub App connection, installed, with a known webhook secret.
    const installationId = randomInt(100_000, 999_999_999);
    github.apps.set(ghAppId, {
      id: ghAppId,
      slug: `launchway-prv-${ghAppId}`,
      webhookSecret,
      privateKey: testPrivateKey(),
      installations: new Map([[installationId, { login: 'octo', type: 'User' as const }]]),
    });
    const connectionId = generateId('gh');
    await db.insert(githubConnections).values({
      id: connectionId,
      kind: 'app',
      name: `prv-${suffix}`,
      appId: ghAppId,
      appSlug: `launchway-prv-${ghAppId}`,
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
    github.addRepo({
      owner: 'octo',
      name: repoName,
      branches: { main: sha('prv-main') },
      pulls: {
        7: { title: 'Manual preview', headRef: 'feature/manual', headSha: sha('prv-7') },
        8: { title: 'From a fork', headRef: 'patch', headSha: sha('prv-8'), fromFork: true },
        9: { title: 'Closed', headRef: 'old', headSha: sha('prv-9'), state: 'closed' },
        10: { title: 'One too many', headRef: 'more', headSha: sha('prv-10') },
      },
    });

    // DNS: an account of the in-memory provider with the zone of the preview base domain.
    const account = (await (
      await api.request(
        '/api/v1/dns/accounts',
        json('POST', { kind, name: `Memory ${suffix}`, credentials: { token: 'prv-token' } }),
      )
    ).json()) as DnsProviderAccount;
    await api.request(`/api/v1/dns/accounts/${account.id}/sync`, json('POST'));

    // The settings row may not exist yet when this file runs first.
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    const [current] = await db.select().from(settings).where(eq(settings.id, 1));
    original = {
      anchorHostname: current?.anchorHostname ?? null,
      previewBaseDomain: current?.previewBaseDomain ?? null,
      previewMaxPerApp: current?.previewMaxPerApp ?? 10,
      previewMaxTotal: current?.previewMaxTotal ?? 20,
      edgeNodeId: current?.edgeNodeId ?? null,
    };
    await db
      .update(settings)
      .set({ anchorHostname: anchor, previewMaxTotal: 100, edgeNodeId: null });

    const [app] = await db
      .insert(apps)
      .values({
        slug,
        name: slug,
        connectionId,
        repoOwner: 'octo',
        repoName,
        composeFiles: ['compose.yaml'],
        nodeId,
      })
      .returning({ id: apps.id });
    appId = app?.id as AppId;
    const [domain] = await db
      .insert(domains)
      .values({ hostname: `${slug}.${zoneName}`, status: 'verified' })
      .returning({ id: domains.id });
    await db.insert(routes).values({
      domainId: domain?.id as never,
      targetKind: 'app',
      appId,
      appService: 'web',
      appPort: 8080,
      compress: false,
    });
  });

  afterAll(async () => {
    // The settings row is a singleton shared with other test files: put it back.
    if (original) await db.update(settings).set(original);
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('accepts only a preview base domain inside a managed zone', async () => {
    const outside = await api.request(
      '/api/v1/settings',
      json('PATCH', { previewBaseDomain: 'preview.unmanaged.example' }),
    );
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ errors: [{ path: 'body.previewBaseDomain' }] });

    const saved = await api.request('/api/v1/settings', json('PATCH', { previewBaseDomain: base }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ previewBaseDomain: base, previewMaxPerApp: 10 });
  });

  it('stores the preview settings of an app and refuses unknown placeholders', async () => {
    const bad = await api.request(
      `/api/v1/apps/${appId}`,
      json('PATCH', { previews: { envOverrides: { BASE_URL: '{{previewURL}}' } } }),
    );
    expect(bad.status).toBe(400);

    const res = await api.request(
      `/api/v1/apps/${appId}`,
      json('PATCH', {
        previews: {
          enabled: true,
          envOverrides: { BASE_URL: '{{previewUrl}}', DB_NAME: 'db_{{prNumber}}' },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      previews: {
        enabled: true,
        hostTemplate: '{slug}-pr-{number}.{base}',
        envOverrides: { BASE_URL: '{{previewUrl}}', DB_NAME: 'db_{{prNumber}}' },
        composeFiles: null,
      },
    });
  });

  it('opens a preview from a pull_request webhook: domain, route and a queued deployment', async () => {
    const head = sha('prv-5a');
    const res = await api.request(
      '/api/v1/webhooks/github',
      webhook('pull_request', pullRequest('opened', 5, head)),
    );
    expect(res.status).toBe(204);

    const row = await previewOf(5);
    const hostname = `${slug}-pr-5.${base}`;
    expect(row).toMatchObject({
      prTitle: 'Change 5',
      branch: 'feature/5',
      headSha: head,
      hostname,
      status: 'deploying',
    });
    if (!row?.domainId || !row.routeId) throw new Error('preview without domain or route');

    const [domain] = await db.select().from(domains).where(eq(domains.id, row.domainId));
    expect(domain).toMatchObject({ hostname, force: true, proxied: false });
    expect(domain?.zoneId).not.toBeNull();
    expect(dns.records.get('z-prv')).toContainEqual(
      expect.objectContaining({ type: 'CNAME', name: hostname, content: anchor }),
    );
    const [route] = await db.select().from(routes).where(eq(routes.id, row.routeId));
    expect(route).toMatchObject({
      targetKind: 'app',
      appId,
      appService: 'web',
      appPort: 8080,
      protected: false,
      compress: false,
    });

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.previewId, row.id));
    expect(deployment).toMatchObject({
      appId,
      trigger: 'preview',
      ref: head,
      commitSha: head,
      environmentName: 'preview/pr-5',
    });

    // Dispatched in the background with the preview's identity and environment.
    await vi.waitFor(() => {
      expect(agents.deployed.map((d) => d.payload.deploymentId)).toContain(deployment?.id);
    });
    const payload = agents.deployed.find((d) => d.payload.deploymentId === deployment?.id)?.payload;
    expect(payload?.app).toEqual({ id: previewAgentAppId(row.id), slug: `${slug}-pr-5` });
    expect(payload?.routes).toEqual([{ service: 'web', port: 8080, alias: `${slug}-pr-5-web` }]);
    expect(payload?.policy).toEqual({ trustedMounts: false, allowedBindRoots: [] });
    expect(payload?.env).toMatchObject({
      BASE_URL: `https://${hostname}`,
      DB_NAME: 'db_5',
      LAUNCHWAY_ENVIRONMENT: 'preview',
      LAUNCHWAY_PREVIEW_NUMBER: '5',
      LAUNCHWAY_PUBLIC_URL: `https://${hostname}`,
    });
    expect(await auditActions(row.id)).toEqual(['preview.create']);

    // Until the preview's deployment runs, its host answers with the placeholder page instead
    // of a proxy to the preview alias, which does not resolve yet.
    const edge = JSON.stringify(await (await api.request('/api/v1/edge/config')).json());
    expect(edge).toContain(
      `placeholder (503), preview #5 of app ${slug} has no running deployment`,
    );
    expect(edge).not.toContain(`reverse_proxy ${slug}-pr-5-web`);
  });

  it('deploys every push and cancels pushes that never left the queue', async () => {
    const second = sha('prv-5b');
    const third = sha('prv-5c');
    for (const head of [second, third]) {
      const res = await api.request(
        '/api/v1/webhooks/github',
        webhook('pull_request', pullRequest('synchronize', 5, head)),
      );
      expect(res.status).toBe(204);
    }
    const row = await previewOf(5);
    expect(row?.headSha).toBe(third);
    const rows = await db
      .select()
      .from(deployments)
      .where(eq(deployments.previewId, row?.id as never));
    const byCommit = new Map(rows.map((r) => [r.commitSha, r]));
    // The first push is with the node, so the second waits in the queue until the third cancels it.
    expect(byCommit.get(second)).toMatchObject({
      status: 'cancelled',
      statusMessage: 'Superseded by a newer commit',
    });
    expect(byCommit.get(third)?.status).toBe('queued');
    expect(await auditActions(row?.id ?? '')).toEqual([
      'preview.create',
      'preview.update',
      'preview.update',
    ]);
  });

  it('ignores pull requests from forks', async () => {
    const res = await api.request(
      '/api/v1/webhooks/github',
      webhook('pull_request', pullRequest('opened', 6, sha('prv-6'), { fork: true })),
    );
    expect(res.status).toBe(204);
    expect(await previewOf(6)).toBeUndefined();
  });

  it('removes containers, route, domain and DNS record when the pull request closes', async () => {
    const row = await previewOf(5);
    if (!row?.domainId || !row.routeId) throw new Error('preview without domain or route');
    const res = await api.request(
      '/api/v1/webhooks/github',
      webhook('pull_request', pullRequest('closed', 5, sha('prv-5c'), { merged: true })),
    );
    expect(res.status).toBe(204);

    const closed = await previewOf(5);
    expect(closed).toMatchObject({ status: 'closed', domainId: null, routeId: null });
    expect(closed?.closedAt).toBeInstanceOf(Date);
    expect(await db.select().from(routes).where(eq(routes.id, row.routeId))).toEqual([]);
    expect(await db.select().from(domains).where(eq(domains.id, row.domainId))).toEqual([]);
    expect(dns.records.get('z-prv')?.map((r) => r.name)).not.toContain(row.hostname);
    expect(agents.removed).toContainEqual({
      nodeId,
      app: { id: previewAgentAppId(row.id), slug: `${slug}-pr-5` },
      removeVolumes: true,
    });
    // The deployment with the node is asked to stop; the one still queued is cancelled at once.
    const left = await db
      .select()
      .from(deployments)
      .where(eq(deployments.previewId, row.id))
      .orderBy(deployments.createdAt);
    expect(agents.cancelled.map((c) => c.deploymentId)).toContain(left[0]?.id);
    expect(left.at(-1)?.status).toBe('cancelled');
    // What the agent would report for the stopped deployment; frees the app's dispatch lane.
    await db
      .update(deployments)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(deployments.previewId, row.id), eq(deployments.status, 'queued')));
    expect(await auditActions(row.id)).toEqual(
      expect.arrayContaining(['preview.close', 'preview.remove']),
    );
    // The production route is untouched.
    expect(
      await db.select({ id: routes.id }).from(routes).where(eq(routes.appId, appId)),
    ).toHaveLength(1);
  });

  it('skips bot pull requests and follows a required label', async () => {
    const hook = async (payload: unknown) =>
      (await api.request('/api/v1/webhooks/github', webhook('pull_request', payload))).status;
    expect(await hook(pullRequest('opened', 11, sha('prv-11'), { bot: true }))).toBe(204);
    expect(await previewOf(11)).toBeUndefined();

    const patched = await api.request(
      `/api/v1/apps/${appId}`,
      json('PATCH', { previews: { requireLabel: ' preview ' } }),
    );
    expect(await patched.json()).toMatchObject({
      previews: { skipBots: true, requireLabel: 'preview' },
    });
    const head = sha('prv-12');
    expect(await hook(pullRequest('opened', 12, head, { labels: ['bug'] }))).toBe(204);
    expect(await previewOf(12)).toBeUndefined();

    // Gaining the label opens the preview; a repeated event for the same head deploys nothing new.
    const labeled = pullRequest('labeled', 12, head, {
      labels: ['bug', 'Preview'],
      label: 'Preview',
    });
    expect(await hook(labeled)).toBe(204);
    expect(await hook(labeled)).toBe(204);
    const row = await previewOf(12);
    expect(row?.status).toBe('deploying');
    const deployed = await db
      .select()
      .from(deployments)
      .where(eq(deployments.previewId, row?.id as never));
    expect(deployed).toHaveLength(1);
    await vi.waitFor(() => {
      expect(agents.deployed.map((d) => d.payload.deploymentId)).toContain(deployed[0]?.id);
    });

    // Losing the label closes the preview like closing the pull request does.
    expect(
      await hook(pullRequest('unlabeled', 12, head, { labels: ['bug'], label: 'Preview' })),
    ).toBe(204);
    expect(await previewOf(12)).toMatchObject({ status: 'closed', routeId: null, domainId: null });
    // What the agent would report for the stopped deployment; frees the app's dispatch lane.
    await db
      .update(deployments)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(deployments.previewId, row?.id as never), eq(deployments.status, 'queued')));
    await api.request(`/api/v1/apps/${appId}`, json('PATCH', { previews: { requireLabel: null } }));
  });

  it('opens, lists, limits and closes previews through the API', async () => {
    const missing = await api.request(
      `/api/v1/apps/${appId}/previews`,
      json('POST', { prNumber: 404 }),
    );
    expect(missing.status).toBe(400);
    expect(
      (await api.request(`/api/v1/apps/${appId}/previews`, json('POST', { prNumber: 8 }))).status,
    ).toBe(409);
    expect(
      (await api.request(`/api/v1/apps/${appId}/previews`, json('POST', { prNumber: 9 }))).status,
    ).toBe(409);

    const created = await api.request(
      `/api/v1/apps/${appId}/previews`,
      json('POST', { prNumber: 7 }),
    );
    expect(created.status).toBe(201);
    const preview = (await created.json()) as Preview;
    expect(preview).toMatchObject({
      prNumber: 7,
      branch: 'feature/manual',
      headSha: sha('prv-7'),
      environmentName: 'preview/pr-7',
      url: `https://${slug}-pr-7.${base}`,
      lastDeployment: { commitSha: sha('prv-7') },
    });

    const open = (await (
      await api.request(`/api/v1/apps/${appId}/previews?open=true`)
    ).json()) as PreviewPage;
    expect(open.items.map((item) => item.prNumber)).toEqual([7]);
    const all = (await (await api.request('/api/v1/previews')).json()) as PreviewPage;
    expect(all.items.map((item) => item.id)).toContain(preview.id);
    expect((await api.request(`/api/v1/previews/${preview.id}`)).status).toBe(200);

    // The per-app limit counts open previews only.
    await db.update(settings).set({ previewMaxPerApp: 1 });
    const limited = await api.request(
      `/api/v1/apps/${appId}/previews`,
      json('POST', { prNumber: 10 }),
    );
    expect(limited.status).toBe(409);
    await db.update(settings).set({ previewMaxPerApp: 10 });

    const redeployed = await api.request(`/api/v1/previews/${preview.id}/redeploy`, json('POST'));
    expect(redeployed.status).toBe(200);

    const closed = await api.request(`/api/v1/previews/${preview.id}`, json('DELETE'));
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ status: 'closed', routeId: null, domainId: null });
    expect(
      (await api.request(`/api/v1/previews/${preview.id}/redeploy`, json('POST'))).status,
    ).toBe(409);
  });

  it('purges closed previews with their deployments after the retention period', async () => {
    const row = await previewOf(7);
    if (!row) throw new Error('preview 7 is missing');
    const service = createPreviewsService(deps);
    await service.reconcile();
    expect(await previewOf(7)).toBeDefined();

    await db
      .update(previews)
      .set({ closedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(previews.id, row.id));
    await service.reconcile();
    expect(await previewOf(7)).toBeUndefined();
    expect(
      await db
        .select()
        .from(deployments)
        .where(inArray(deployments.previewId, [row.id])),
    ).toEqual([]);
    expect(await auditActions(row.id)).toContain('preview.purge');
  });
});
