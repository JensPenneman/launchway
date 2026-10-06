import { AGENT_CLOSE_CODES, type CreatedNode, type Node } from '@slipway/contracts';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { auditEvents, nodes, settings } from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { noopDeploymentSink } from '../../src/lib/agent-gateway.js';
import { createAgentGateway, type NodeAgentGateway } from '../../src/modules/nodes/gateway.js';
import { ensureLocalNode, LOCAL_NODE_NAME } from '../../src/modules/nodes/service.js';
import { startTestServer, TestAgent } from '../support/agent-client.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { insertApp, unique } from '../support/edge-fixtures.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function eventually(check: () => Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe('nodes and the agent socket against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let gateway: NodeAgentGateway;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  const admin = testPrincipal('admin');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    const base = createTestDeps({ db, auth: fixedAuth(admin) });
    gateway = createAgentGateway({ deps: base, sink: noopDeploymentSink });
    deps = { ...base, agents: gateway };
    await gateway.start();
    server = await startTestServer(deps);
  });

  afterAll(async () => {
    gateway.stop();
    await server.close();
    await pool.end();
  });

  async function createNode(): Promise<CreatedNode> {
    const res = await createApp(deps).request(
      '/api/v1/nodes',
      json('POST', { name: unique('nuc-') }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as CreatedNode;
  }

  it('creates a node, joins it over the WebSocket and reports it online', async () => {
    const app = createApp(deps);
    const created = await createNode();
    expect(created.node).toMatchObject({ status: 'pending', isEdge: false, joinedAt: null });
    expect(created.joinToken.token).toMatch(/^slpn_/);
    // ws://<request origin>, or the public URL another test file may have set.
    expect(created.joinToken.serverUrl).toMatch(/^wss?:\/\/[^/]+$/);
    expect(created.joinToken.dockerRunCommand).toContain(created.joinToken.token);

    const [stored] = await db.select().from(nodes).where(eq(nodes.id, created.node.id));
    expect(stored?.joinTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.joinTokenHash).not.toContain(created.joinToken.token);

    const agent = await TestAgent.connect(server.url, created.joinToken.token);
    const ok = await agent.handshake({ lanIp: '192.168.1.40', hostname: 'nuc' });
    expect(ok.payload.nodeId).toBe(created.node.id);
    const credential = ok.payload.credential ?? '';
    expect(credential).toMatch(/^slpa_/);

    const node = (await (await app.request(`/api/v1/nodes/${created.node.id}`)).json()) as Node;
    expect(node).toMatchObject({
      status: 'online',
      lanIp: '192.168.1.40',
      hostname: 'nuc',
      arch: 'arm64',
      agentVersion: '0.1.0-test',
      protocolVersion: 1,
    });
    expect(node.joinedAt).not.toBeNull();

    const [join] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'node.join'), eq(auditEvents.targetId, created.node.id)));
    expect(join).toMatchObject({ actorType: 'agent', actorId: created.node.id });

    // The join token was consumed; the credential reconnects (and replaces the first socket).
    await expect(TestAgent.connect(server.url, created.joinToken.token)).rejects.toThrow('401');
    const second = await TestAgent.connect(server.url, credential);
    await second.handshake();
    expect((await agent.closed).code).toBe(AGENT_CLOSE_CODES.replaced);

    // Heartbeats update last_seen_at.
    const before = (await db.select().from(nodes).where(eq(nodes.id, created.node.id)))[0]
      ?.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.send('heartbeat', { sentAt: new Date().toISOString(), activeDeploymentIds: [] });
    await eventually(async () => {
      const [row] = await db.select().from(nodes).where(eq(nodes.id, created.node.id));
      expect(row?.lastSeenAt?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    });

    second.close();
    await eventually(async () => {
      const [row] = await db.select().from(nodes).where(eq(nodes.id, created.node.id));
      expect(row?.status).toBe('offline');
    });
  });

  it('rotates the credential of an online node and revokes it', async () => {
    const app = createApp(deps);
    const created = await createNode();
    const agent = await TestAgent.connect(server.url, created.joinToken.token);
    const first = (await agent.handshake()).payload.credential ?? '';

    const rotated = await app.request(
      `/api/v1/nodes/${created.node.id}/credential/rotate`,
      json('POST'),
    );
    expect(rotated.status).toBe(200);
    const pushed = (await agent.next('hello.ok')).payload.credential ?? '';
    expect(pushed).toMatch(/^slpa_/);
    expect(pushed).not.toBe(first);
    await expect(TestAgent.connect(server.url, first)).rejects.toThrow('401');

    const revoked = await app.request(
      `/api/v1/nodes/${created.node.id}/credential/revoke`,
      json('POST'),
    );
    expect(revoked.status).toBe(200);
    expect((await revoked.json()) as Node).toMatchObject({ status: 'offline' });
    expect((await agent.closed).code).toBe(AGENT_CLOSE_CODES.revoked);
    await expect(TestAgent.connect(server.url, pushed)).rejects.toThrow('401');

    // Rotation needs a connected agent.
    const offline = await app.request(
      `/api/v1/nodes/${created.node.id}/credential/rotate`,
      json('POST'),
    );
    expect(offline.status).toBe(409);

    const actions = (
      await db.select().from(auditEvents).where(eq(auditEvents.targetId, created.node.id))
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'node.create',
        'node.join',
        'node.credential.rotate',
        'node.credential.revoke',
      ]),
    );
  });

  it('renames, lists, issues join tokens and refuses to delete nodes with apps', async () => {
    const app = createApp(deps);
    const created = await createNode();
    const id = created.node.id;

    const renamed = await app.request(
      `/api/v1/nodes/${id}`,
      json('PATCH', { name: `${created.node.name}-x` }),
    );
    expect(renamed.status).toBe(200);
    const duplicate = await app.request(
      '/api/v1/nodes',
      json('POST', { name: `${created.node.name}-x` }),
    );
    expect(duplicate.status).toBe(409);

    const list = (await (await app.request('/api/v1/nodes')).json()) as { items: Node[] };
    expect(list.items.map((n) => n.id)).toContain(id);

    const token = await app.request(`/api/v1/nodes/${id}/join-token`, json('POST'));
    expect(token.status).toBe(201);
    expect(((await token.json()) as { token: string }).token).not.toBe(created.joinToken.token);
    await expect(TestAgent.connect(server.url, created.joinToken.token)).rejects.toThrow('401');

    const appId = await insertApp(db, id);
    const refused = await app.request(`/api/v1/nodes/${id}`, json('DELETE'));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ type: 'conflict' });

    const other = await createNode();
    expect((await app.request(`/api/v1/nodes/${other.node.id}`, json('DELETE'))).status).toBe(204);
    expect((await app.request(`/api/v1/nodes/${other.node.id}`)).status).toBe(404);
    expect(appId).toMatch(/^app_/);
  });

  it('bootstraps the local node from SLIPWAY_LOCAL_JOIN_TOKEN and makes it the edge', async () => {
    const [previous] = await db.select().from(settings).where(eq(settings.id, 1));
    const token = `slpn_${'L'.repeat(43)}`;
    const local = { ...deps, config: { ...deps.config, localJoinToken: token } };
    try {
      await db.update(settings).set({ edgeNodeId: null }).where(eq(settings.id, 1));
      const id = await ensureLocalNode(local);
      expect(await ensureLocalNode(local)).toBe(id);
      const [row] = await db.select().from(nodes).where(eq(nodes.name, LOCAL_NODE_NAME));
      expect(row?.id).toBe(id);
      expect(row?.joinTokenExpiresAt).toBeNull();

      const node = (await (await createApp(deps).request(`/api/v1/nodes/${id}`)).json()) as Node;
      expect(node.isEdge).toBe(true);

      // The bootstrap token is reusable (the bundled agent may lose its volume).
      for (let i = 0; i < 2; i++) {
        const agent = await TestAgent.connect(server.url, token);
        expect((await agent.handshake()).payload.credential).toMatch(/^slpa_/);
        agent.close();
        await agent.closed;
      }
    } finally {
      // Leave the shared settings row (and its audit trail) as other test files expect it.
      await db
        .delete(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'settings.update'),
            eq(auditEvents.actorLabel, 'local-node-bootstrap'),
          ),
        );
      await db
        .update(settings)
        .set({ edgeNodeId: previous?.edgeNodeId ?? null })
        .where(eq(settings.id, 1));
    }
  });
});
