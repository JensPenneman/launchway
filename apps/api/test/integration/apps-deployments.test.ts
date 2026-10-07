import {
  type App,
  type Deployment,
  type EnvVarList,
  type GitHubConnection,
  generateId,
  type NodeId,
  QUEUED_DEPLOYMENT_TIMEOUT_MS,
  type ServiceStatus,
} from '@slipway/contracts';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import {
  auditEvents,
  deployments,
  domains,
  envVars,
  githubConnections,
  nodes,
  routes,
  settings,
  users,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { AgentRequestError } from '../../src/lib/agent-gateway.js';
import type { Principal } from '../../src/lib/auth-context.js';
import { basicAuthorization } from '../../src/lib/git-provider.js';
import { createDispatcher } from '../../src/modules/deployments/dispatcher.js';
import {
  createDeploymentSink,
  LOST_DEPLOYMENT_MESSAGE,
} from '../../src/modules/deployments/sink.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { FakeAgentGateway } from '../support/fake-agent-gateway.js';
import { FakeGitHub, sha } from '../support/fake-github.js';
import { parseSse } from '../support/sse.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const SERVICES: ServiceStatus[] = [
  { service: 'web', containerId: 'c1', state: 'running', health: 'healthy', publishedPorts: [] },
];

let counter = 0;
const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

describe('apps and deployments against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  let adminApi: ReturnType<typeof createApp>;
  const github = new FakeGitHub();
  const gateway = new FakeAgentGateway();
  const member = testPrincipal('member');
  const admin = testPrincipal('admin');
  const pat = `ghp_${'p'.repeat(36)}`;
  let edgeNode: NodeId;
  let otherNode: NodeId;
  let connection: GitHubConnection;

  async function insertUser(principal: Principal) {
    await db.insert(users).values({
      id: principal.user.id,
      email: `${unique('u')}@example.com`,
      name: principal.user.name,
      role: principal.user.role,
    });
  }

  async function insertNode(lanIp: string): Promise<NodeId> {
    const [row] = await db
      .insert(nodes)
      .values({ name: unique('node'), status: 'online', lanIp })
      .returning({ id: nodes.id });
    if (!row) throw new Error('no node');
    return row.id;
  }

  async function createTestApp(nodeId: NodeId, extra: Record<string, unknown> = {}): Promise<App> {
    const repo = github.addRepo({
      owner: 'octo',
      name: unique('repo'),
      tags: { 'v1.0.0': sha('v1.0.0'), 'v1.1.0': sha('v1.1.0'), 'v2.0.0': sha('v2.0.0') },
      branches: { main: sha('main') },
    });
    const res = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: unique('App'),
        connectionId: connection.id,
        repository: { owner: repo.owner, name: repo.name },
        nodeId,
        ...extra,
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as App;
  }

  async function deploy(appId: string, ref: string): Promise<Deployment> {
    const res = await api.request(`/api/v1/apps/${appId}/deployments`, json('POST', { ref }));
    expect(res.status).toBe(201);
    return (await res.json()) as Deployment;
  }

  async function getDeployment(id: string): Promise<Deployment> {
    return (await (await api.request(`/api/v1/deployments/${id}`)).json()) as Deployment;
  }

  /** Plays the agent side of a successful deployment through the sink. */
  async function runToCompletion(deployment: Deployment, nodeId: NodeId) {
    const sink = createDeploymentSink(deps);
    const at = new Date().toISOString();
    await sink.onProgress(nodeId, { deploymentId: deployment.id, status: 'cloning' });
    await sink.onLog(nodeId, {
      deploymentId: deployment.id,
      lines: [
        { seq: 0, timestamp: at, stream: 'system', line: 'cloning' },
        { seq: 1, timestamp: at, stream: 'stdout', line: 'cloned' },
      ],
    });
    await sink.onProgress(nodeId, { deploymentId: deployment.id, status: 'building' });
    await sink.onProgress(nodeId, { deploymentId: deployment.id, status: 'starting' });
    await sink.onLog(nodeId, {
      deploymentId: deployment.id,
      lines: [{ seq: 0, timestamp: at, stream: 'stderr', line: 'started' }],
    });
    await sink.onResult(nodeId, {
      deploymentId: deployment.id,
      outcome: 'succeeded',
      services: SERVICES,
    });
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    github.addPat(pat);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    deps = createTestDeps({ db, auth: fixedAuth(member), agents: gateway });
    api = createApp(deps);
    adminApi = createApp({ ...deps, auth: fixedAuth(admin) });
    await insertUser(member);
    await insertUser(admin);
    edgeNode = await insertNode('192.168.1.10');
    otherNode = await insertNode('192.168.1.30');
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    await db.update(settings).set({ edgeNodeId: edgeNode }).where(eq(settings.id, 1));

    const res = await adminApi.request(
      '/api/v1/github/connections/pat',
      json('POST', { name: 'Personal', token: pat }),
    );
    expect(res.status).toBe(201);
    connection = (await res.json()) as GitHubConnection;
  });

  afterAll(async () => {
    await db.update(settings).set({ edgeNodeId: null }).where(eq(settings.id, 1));
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('stores the PAT connection encrypted', async () => {
    expect(connection).toMatchObject({ kind: 'pat', account: { login: 'octo', type: 'User' } });
    const [row] = await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, connection.id));
    expect(row?.tokenEncrypted).toBeTruthy();
    expect(row?.tokenEncrypted).not.toContain(pat);
  });

  it('creates an app, sets env, deploys, runs, supersedes and replays the log history', async () => {
    const app = await createTestApp(otherNode);
    expect(app).toMatchObject({ composeFiles: ['compose.yaml'], activeDeploymentId: null });
    const [domain] = await db
      .insert(domains)
      .values({ hostname: `${app.slug}.example.com` })
      .returning();
    await db.insert(routes).values({
      domainId: domain?.id ?? generateId('dom'),
      targetKind: 'app',
      appId: app.id,
      appService: 'web',
      appPort: 8080,
    });

    const envRes = await api.request(
      `/api/v1/apps/${app.id}/env`,
      json('PUT', {
        variables: [
          { key: 'PLAIN', value: 'visible' },
          { key: 'TOKEN', value: 'hidden-value', secret: true },
        ],
      }),
    );
    expect(envRes.status).toBe(200);
    const env = (await envRes.json()) as EnvVarList;
    expect(env.items.map((v) => [v.key, v.value])).toEqual([
      ['PLAIN', 'visible'],
      ['TOKEN', null],
    ]);
    const [stored] = await db
      .select()
      .from(envVars)
      .where(and(eq(envVars.appId, app.id), eq(envVars.key, 'TOKEN')));
    expect(stored?.valueEncrypted).not.toContain('hidden-value');

    gateway.connect(otherNode);
    const first = await deploy(app.id, 'v1.0.0');
    expect(first).toMatchObject({ status: 'queued', commitSha: sha('v1.0.0'), trigger: 'manual' });
    expect(first.triggeredBy).toBe(member.user.id);
    expect(first.startedAt).not.toBeNull(); // dispatched
    const sent = gateway.deployed.find((d) => d.payload.deploymentId === first.id);
    expect(sent?.nodeId).toBe(otherNode);
    expect(sent?.payload).toMatchObject({
      app: { id: app.id, slug: app.slug },
      source: {
        cloneUrl: `https://github.com/${app.repository.owner}/${app.repository.name}.git`,
        ref: 'v1.0.0',
        commitSha: sha('v1.0.0'),
        authorization: basicAuthorization(pat),
      },
      build: { kind: 'compose', composeFiles: ['compose.yaml'] },
      env: { PLAIN: 'visible', TOKEN: 'hidden-value' },
      routes: [{ service: 'web', port: 8080, alias: `${app.slug}-web` }],
      network: { proxyNetwork: 'slipway-proxy', publishOnIp: '192.168.1.30' },
    });

    await runToCompletion(first, otherNode);
    expect(await getDeployment(first.id)).toMatchObject({ status: 'running', services: SERVICES });
    const active = (await (await api.request(`/api/v1/apps/${app.id}`)).json()) as App;
    expect(active.activeDeploymentId).toBe(first.id);

    const second = await deploy(app.id, 'v1.1.0');
    expect(gateway.deployed.some((d) => d.payload.deploymentId === second.id)).toBe(true);
    await runToCompletion(second, otherNode);
    expect((await getDeployment(first.id)).status).toBe('superseded');
    expect((await getDeployment(second.id)).status).toBe('running');

    const list = (await (
      await api.request(`/api/v1/apps/${app.id}/deployments?limit=1`)
    ).json()) as { items: Deployment[]; nextCursor: string };
    expect(list.items.map((d) => d.id)).toEqual([second.id]);
    const next = (await (
      await api.request(`/api/v1/apps/${app.id}/deployments?limit=1&cursor=${list.nextCursor}`)
    ).json()) as { items: Deployment[]; nextCursor: string | null };
    expect(next).toMatchObject({ items: [{ id: first.id }], nextCursor: null });

    const logs = await api.request(`/api/v1/deployments/${first.id}/logs`);
    expect(logs.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await logs.text());
    expect(events).toEqual([
      { event: 'log', id: '0', data: expect.objectContaining({ seq: 0, line: 'cloning' }) },
      { event: 'log', id: '1', data: expect.objectContaining({ seq: 1, line: 'cloned' }) },
      { event: 'log', id: '2', data: expect.objectContaining({ seq: 2, stream: 'stderr' }) },
      { event: 'end', data: { status: 'superseded' } },
    ]);
    const after = parseSse(
      await (await api.request(`/api/v1/deployments/${first.id}/logs?after=1`)).text(),
    );
    expect(after.map((e) => e.id)).toEqual(['2', undefined]);

    const actions = (
      await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, app.id))
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['app.create', 'env.replace']));
    const [succeeded] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.targetId, second.id), eq(auditEvents.action, 'deployment.succeed')),
      );
    expect(succeeded).toMatchObject({ actorType: 'agent', actorId: otherNode });
  });

  it('streams live lines and status with follow=true until the deployment ends', async () => {
    gateway.connect(edgeNode);
    const app = await createTestApp(edgeNode);
    const deployment = await deploy(app.id, 'main');
    const sent = gateway.deployed.find((d) => d.payload.deploymentId === deployment.id);
    expect(sent?.payload.network.publishOnIp).toBeNull(); // edge node

    const res = await api.request(`/api/v1/deployments/${deployment.id}/logs?follow=true`);
    const body = res.text();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runToCompletion(deployment, edgeNode);
    const events = parseSse(await body);
    expect(events.filter((e) => e.event === 'log')).toHaveLength(3);
    expect(events.filter((e) => e.event === 'status').map((e) => e.data)).toEqual(
      expect.arrayContaining([{ status: 'building' }, { status: 'running' }]),
    );
    expect(events.at(-1)).toEqual({ event: 'end', data: { status: 'running' } });
  });

  it('keeps one deployment in progress per app, cancels, handles offline nodes and timeouts', async () => {
    const node = await insertNode('192.168.1.40');
    gateway.connect(node);
    const app = await createTestApp(node);
    const sink = createDeploymentSink(deps);

    const a = await deploy(app.id, 'v1.0.0');
    const b = await deploy(app.id, 'v1.1.0');
    expect(b.startedAt).toBeNull();
    expect(gateway.deployed.some((d) => d.payload.deploymentId === b.id)).toBe(false);

    const cancelled = await api.request(`/api/v1/deployments/${b.id}/cancel`, json('POST'));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect((await api.request(`/api/v1/deployments/${b.id}/cancel`, json('POST'))).status).toBe(
      409,
    );

    const c = await deploy(app.id, 'v2.0.0');
    await sink.onProgress(node, { deploymentId: a.id, status: 'cloning' });
    // A report from another node and an invalid transition are ignored.
    await sink.onProgress(otherNode, { deploymentId: a.id, status: 'building' });
    await sink.onProgress(node, { deploymentId: a.id, status: 'starting' });
    expect((await getDeployment(a.id)).status).toBe('cloning');

    gateway.disconnect(node);
    await sink.onNodeOffline(node);
    expect(await getDeployment(a.id)).toMatchObject({
      status: 'failed',
      statusMessage: 'node went offline',
    });
    expect(await getDeployment(c.id)).toMatchObject({ status: 'queued', startedAt: null });

    const dispatcher = createDispatcher(deps);
    await dispatcher.tick();
    expect(gateway.deployed.some((d) => d.payload.deploymentId === c.id)).toBe(false);
    gateway.connect(node);
    await dispatcher.tick();
    expect(gateway.deployed.some((d) => d.payload.deploymentId === c.id)).toBe(true);

    // An in-flight cancel goes to the agent, which reports the outcome.
    const requested = await api.request(`/api/v1/deployments/${c.id}/cancel`, json('POST'));
    expect(await requested.json()).toMatchObject({
      status: 'queued',
      statusMessage: 'Cancellation requested',
    });
    expect(gateway.cancelled).toContainEqual({ nodeId: node, deploymentId: c.id });
    await sink.onResult(node, { deploymentId: c.id, outcome: 'cancelled' });
    expect((await getDeployment(c.id)).status).toBe('cancelled');

    const d = await deploy(app.id, 'main');
    gateway.disconnect(node);
    await sink.onNodeOffline(node);
    await dispatcher.tick(new Date(Date.now() + QUEUED_DEPLOYMENT_TIMEOUT_MS + 1000));
    expect(await getDeployment(d.id)).toMatchObject({ status: 'failed' });
    expect((await getDeployment(d.id)).statusMessage).toMatch(/Timed out/);

    const [failedAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, a.id), eq(auditEvents.action, 'deployment.fail')));
    expect(failedAudit).toBeDefined();
  });

  it('keeps queued work on online nodes and settles deployments the agent stops reporting', async () => {
    const node = await insertNode('192.168.1.43');
    gateway.connect(node);
    const app = await createTestApp(node);
    const sink = createDeploymentSink(deps);
    const a = await deploy(app.id, 'v1.0.0');
    const b = await deploy(app.id, 'v1.1.0');
    await sink.onProgress(node, { deploymentId: a.id, status: 'cloning' });

    // Waiting behind a long build on an online node is not a dispatch timeout.
    await createDispatcher(deps).tick(new Date(Date.now() + QUEUED_DEPLOYMENT_TIMEOUT_MS + 1000));
    expect((await getDeployment(b.id)).status).toBe('queued');

    // Listed by the agent: kept. Left out of two heartbeats once old enough: its result was lost.
    await db
      .update(deployments)
      .set({ startedAt: new Date(Date.now() - 60_000) })
      .where(eq(deployments.id, a.id));
    await sink.onHeartbeat?.(node, [a.id]);
    await sink.onHeartbeat?.(node, []);
    expect((await getDeployment(a.id)).status).toBe('cloning');
    await sink.onHeartbeat?.(node, []);
    expect(await getDeployment(a.id)).toMatchObject({
      status: 'failed',
      statusMessage: LOST_DEPLOYMENT_MESSAGE,
    });
    // The app is free again: the next queued deployment goes out.
    await vi.waitFor(() =>
      expect(gateway.deployed.some((d) => d.payload.deploymentId === b.id)).toBe(true),
    );
  });

  it('cancels locally when the agent does not know the deployment, 502 when it does not answer', async () => {
    const node = await insertNode('192.168.1.42');
    gateway.connect(node);
    const app = await createTestApp(node);
    const sent = await deploy(app.id, 'v1.0.0');
    // Dispatched, so a cancel has to go through the agent.
    expect((await getDeployment(sent.id)).startedAt).not.toBeNull();

    gateway.cancelError = new AgentRequestError(node, 'timeout', 'no answer in time', true);
    const timedOut = await api.request(`/api/v1/deployments/${sent.id}/cancel`, json('POST'));
    expect(timedOut.status).toBe(502);
    expect((await getDeployment(sent.id)).status).toBe('queued');

    gateway.cancelError = new AgentRequestError(node, 'not-found', 'unknown deployment', false);
    const unknown = await api.request(`/api/v1/deployments/${sent.id}/cancel`, json('POST'));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ status: 'cancelled' });
  });

  it('fails a deployment the agent refuses and resolves unknown refs as validation errors', async () => {
    const node = await insertNode('192.168.1.41');
    gateway.connect(node);
    const app = await createTestApp(node);
    gateway.deployError = new Error('policy-violation: privileged');
    const refused = await deploy(app.id, 'v1.0.0');
    expect(refused).toMatchObject({ status: 'failed' });
    expect(refused.statusMessage).toContain('policy-violation');

    const res = await api.request(
      `/api/v1/apps/${app.id}/deployments`,
      json('POST', { ref: 'v9.9.9' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ path: 'body.ref' }] });
  });

  it('manages single env vars and masks secrets', async () => {
    const app = await createTestApp(edgeNode);
    const base = `/api/v1/apps/${app.id}/env`;
    const events: string[] = [];
    const off = deps.events.subscribe((e) => {
      if (e.resourceId === app.id)
        events.push(`${e.topic}.${e.action}:${JSON.stringify(e.data ?? {})}`);
    });

    expect((await api.request(`${base}/NEW`, json('PUT', { secret: true }))).status).toBe(400);
    const created = await api.request(
      `${base}/API_KEY`,
      json('PUT', { value: 'k1', secret: true }),
    );
    expect(await created.json()).toMatchObject({ key: 'API_KEY', secret: true, value: null });
    const plain = await api.request(`${base}/API_KEY`, json('PUT', { secret: false, value: 'k2' }));
    expect(await plain.json()).toMatchObject({ secret: false, value: 'k2' });
    const hidden = await api.request(`${base}/API_KEY`, json('PUT', { secret: true }));
    expect(await hidden.json()).toMatchObject({ secret: true, value: null });

    const kept = await api.request(
      base,
      json('PUT', {
        variables: [
          { key: 'API_KEY', secret: true },
          { key: 'OTHER', value: 'o' },
        ],
      }),
    );
    expect(((await kept.json()) as EnvVarList).items.map((v) => v.key)).toEqual([
      'API_KEY',
      'OTHER',
    ]);
    const [row] = await db
      .select()
      .from(envVars)
      .where(and(eq(envVars.appId, app.id), eq(envVars.key, 'API_KEY')));
    expect(deps.secrets.decrypt(row?.valueEncrypted ?? '', `env:${app.id}:API_KEY`)).toBe('k2');

    expect((await api.request(`${base}/OTHER`, json('DELETE'))).status).toBe(204);
    expect((await api.request(`${base}/OTHER`, json('DELETE'))).status).toBe(404);
    off();
    expect(events).toContain('apps.updated:{"redeployRequired":true,"reason":"env"}');
    expect(events).toContain('env.updated:{}');
  });

  it('reports status, stops, streams container logs and deletes apps', async () => {
    const node = await insertNode('192.168.1.42');
    gateway.connect(node);
    const app = await createTestApp(node);
    const deployment = await deploy(app.id, 'v1.0.0');
    await runToCompletion(deployment, node);
    gateway.services = SERVICES;
    gateway.logLines = [
      { service: 'web', timestamp: new Date().toISOString(), stream: 'stdout', line: 'hello' },
    ];

    const status = await (await api.request(`/api/v1/apps/${app.id}/status`)).json();
    expect(status).toMatchObject({
      source: 'agent',
      nodeOnline: true,
      activeDeploymentId: deployment.id,
    });

    const logs = parseSse(await (await api.request(`/api/v1/apps/${app.id}/logs?tail=10`)).text());
    expect(logs).toEqual([
      { event: 'log', data: expect.objectContaining({ line: 'hello' }) },
      { event: 'end', data: { reason: 'completed' } },
    ]);

    // Stopping cancels what has not been sent yet, so it cannot start the app again afterwards.
    await deploy(app.id, 'v1.1.0');
    const waiting = await deploy(app.id, 'v2.0.0');
    expect(waiting.startedAt).toBeNull();

    const stopped = await api.request(`/api/v1/apps/${app.id}/stop`, json('POST'));
    expect(stopped.status).toBe(200);
    expect((await getDeployment(deployment.id)).status).toBe('stopped');
    expect(await getDeployment(waiting.id)).toMatchObject({
      status: 'cancelled',
      statusMessage: 'Cancelled: the app was stopped',
    });

    gateway.disconnect(node);
    const offline = await (await api.request(`/api/v1/apps/${app.id}/status`)).json();
    expect(offline).toMatchObject({ source: 'last-deployment', nodeOnline: false });
    expect((await api.request(`/api/v1/apps/${app.id}/logs`)).status).toBe(503);

    // The connection cannot go while the app uses it.
    expect(
      (await adminApi.request(`/api/v1/github/connections/${connection.id}`, json('DELETE')))
        .status,
    ).toBe(409);

    expect((await api.request(`/api/v1/apps/${app.id}`, json('DELETE'))).status).toBe(409);
    expect((await api.request(`/api/v1/apps/${app.id}?force=true`, json('DELETE'))).status).toBe(
      204,
    );
    expect((await api.request(`/api/v1/apps/${app.id}`)).status).toBe(404);
    expect(await db.select().from(deployments).where(eq(deployments.appId, app.id))).toEqual([]);

    const online = await createTestApp(node);
    gateway.connect(node);
    expect(
      (await api.request(`/api/v1/apps/${online.id}?removeVolumes=true`, json('DELETE'))).status,
    ).toBe(204);
    expect(gateway.removed).toContainEqual({
      nodeId: node,
      app: { id: online.id, slug: online.slug },
      removeVolumes: true,
    });
  });

  it('validates references, slugs and node moves on create and update', async () => {
    const base = {
      name: unique('App'),
      connectionId: connection.id,
      repository: { owner: 'octo', name: 'whatever' },
      nodeId: edgeNode,
    };
    const unknownNode = await api.request(
      '/api/v1/apps',
      json('POST', { ...base, nodeId: generateId('node') }),
    );
    expect(await unknownNode.json()).toMatchObject({ errors: [{ path: 'body.nodeId' }] });
    const unknownConnection = await api.request(
      '/api/v1/apps',
      json('POST', { ...base, connectionId: generateId('gh') }),
    );
    expect(await unknownConnection.json()).toMatchObject({
      errors: [{ path: 'body.connectionId' }],
    });

    const slug = unique('dup').slice(0, 40);
    expect((await api.request('/api/v1/apps', json('POST', { ...base, slug }))).status).toBe(201);
    expect((await api.request('/api/v1/apps', json('POST', { ...base, slug }))).status).toBe(409);

    gateway.connect(edgeNode);
    const app = await createTestApp(edgeNode);
    const switched = await api.request(
      `/api/v1/apps/${app.id}`,
      json('PATCH', { dockerfile: 'docker/Dockerfile', autoDeployReleases: true }),
    );
    expect(await switched.json()).toMatchObject({
      composeFiles: null,
      dockerfile: 'docker/Dockerfile',
      context: '.',
      autoDeployReleases: true,
    });
    await deploy(app.id, 'v1.0.0');
    const move = await api.request(`/api/v1/apps/${app.id}`, json('PATCH', { nodeId: otherNode }));
    expect(move.status).toBe(409);
  });
});
