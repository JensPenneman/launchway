import {
  AGENT_CLOSE_CODES,
  type AppId,
  type DeploymentId,
  type DeployPayload,
  generateId,
  type HelloPayload,
  type NodeId,
  type PlatformEvent,
} from '@launchway/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helloPayload, startTestServer, TestAgent } from '../../../test/support/agent-client.js';
import { createTestDeps } from '../../../test/support/deps.js';
import {
  AgentRequestError,
  AgentUnavailableError,
  type DeploymentSink,
} from '../../lib/agent-gateway.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import type { AgentAuth, NodeAgentStore } from './agent-store.js';
import { createAgentGateway, type GatewayTimeouts, type NodeAgentGateway } from './gateway.js';

interface MemoryNode {
  id: NodeId;
  joinTokenHash: string | null;
  credentialHash: string | null;
  status: 'pending' | 'online' | 'offline';
  hello: HelloPayload | null;
  lastSeenAt: Date | null;
}

/** In-memory NodeAgentStore with the same token rules as the PostgreSQL store. */
function memoryStore() {
  const nodes = new Map<NodeId, MemoryNode>();
  const touches: NodeId[] = [];
  const store: NodeAgentStore = {
    authenticate(token) {
      const hash = hashToken(token);
      for (const node of nodes.values()) {
        if (token.startsWith('lwyn_') && node.joinTokenHash === hash) {
          return Promise.resolve<AgentAuth>({ nodeId: node.id, via: 'join', tokenHash: hash });
        }
        if (token.startsWith('lwya_') && node.credentialHash === hash) {
          return Promise.resolve<AgentAuth>({
            nodeId: node.id,
            via: 'credential',
            tokenHash: hash,
          });
        }
      }
      return Promise.resolve(null);
    },
    completeHandshake(auth, hello) {
      const node = nodes.get(auth.nodeId);
      const valid =
        auth.via === 'join'
          ? node?.joinTokenHash === auth.tokenHash
          : node?.credentialHash === auth.tokenHash;
      if (!node || !valid) return Promise.resolve({ ok: false });
      let credential: string | null = null;
      if (auth.via === 'join') {
        credential = generateToken('lwya_');
        node.credentialHash = hashToken(credential);
        node.joinTokenHash = null;
      }
      Object.assign(node, { status: 'online', hello, lastSeenAt: new Date() });
      return Promise.resolve({ ok: true, credential });
    },
    touch(nodeId, at) {
      touches.push(nodeId);
      const node = nodes.get(nodeId);
      if (node) node.lastSeenAt = at;
      return Promise.resolve();
    },
    markOffline(nodeId) {
      const node = nodes.get(nodeId);
      if (node?.status === 'online') node.status = 'offline';
      return Promise.resolve();
    },
    markAllOffline() {
      const ids = [...nodes.values()].filter((n) => n.status === 'online').map((n) => n.id);
      for (const id of ids) this.markOffline(id).catch(() => undefined);
      return Promise.resolve(ids);
    },
  };
  /** Adds a node with a fresh join token; returns the plaintext token. */
  function addNode(): { id: NodeId; joinToken: string } {
    const id = generateId('node');
    const joinToken = generateToken('lwyn_');
    nodes.set(id, {
      id,
      joinTokenHash: hashToken(joinToken),
      credentialHash: null,
      status: 'pending',
      hello: null,
      lastSeenAt: null,
    });
    return { id, joinToken };
  }
  return { store, nodes, touches, addNode };
}

function recordingSink() {
  const calls: { method: string; nodeId: NodeId; payload?: unknown }[] = [];
  const record =
    (method: string) =>
    (nodeId: NodeId, payload?: unknown): Promise<void> => {
      calls.push({ method, nodeId, payload });
      return Promise.resolve();
    };
  const sink: DeploymentSink = {
    onProgress: record('onProgress'),
    onLog: record('onLog'),
    onResult: record('onResult'),
    onAppStatus: record('onAppStatus'),
    onNodeOffline: record('onNodeOffline'),
    onNodeOnline: record('onNodeOnline'),
    onHeartbeat: record('onHeartbeat'),
  };
  return { sink, calls };
}

const app = { id: generateId('app') as AppId, slug: 'trail' };

function deployPayload(deploymentId: DeploymentId): DeployPayload {
  return {
    deploymentId,
    app,
    source: {
      cloneUrl: 'https://github.com/example/trail.git',
      ref: 'v1.0.0',
      commitSha: '3f786850e387550fdab836ed7e6dc881de23001b',
      authorization: null,
    },
    build: { kind: 'compose', composeFiles: ['compose.yaml'] },
    env: {},
    routes: [{ service: 'web', port: 8080, alias: 'trail-web' }],
    attach: [],
    network: { proxyNetwork: 'launchway-proxy', publishOnIp: null },
  };
}

async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe('agent gateway over a real WebSocket', () => {
  let memory: ReturnType<typeof memoryStore>;
  let recorded: ReturnType<typeof recordingSink>;
  let gateway: NodeAgentGateway;
  let events: PlatformEvent[];
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let agents: TestAgent[];

  async function setup(timeouts: Partial<GatewayTimeouts> = {}) {
    memory = memoryStore();
    recorded = recordingSink();
    const base = createTestDeps();
    gateway = createAgentGateway({
      deps: base,
      sink: recorded.sink,
      store: memory.store,
      timeouts: { helloMs: 500, ...timeouts },
    });
    const deps = { ...base, agents: gateway };
    events = [];
    deps.events.subscribe((event) => events.push(event));
    await gateway.start();
    server = await startTestServer(deps);
  }

  async function connect(token: string): Promise<TestAgent> {
    const agent = await TestAgent.connect(server.url, token);
    agents.push(agent);
    return agent;
  }

  /** A node that joined with its join token; returns the agent and its issued credential. */
  async function joined(overrides: Partial<HelloPayload> = {}) {
    const node = memory.addNode();
    const agent = await connect(node.joinToken);
    const ok = await agent.handshake(overrides);
    return { node, agent, credential: ok.payload.credential };
  }

  beforeEach(() => {
    agents = [];
  });

  afterEach(async () => {
    for (const agent of agents) agent.close();
    gateway.stop();
    await server.close();
  });

  it('refuses upgrades without a valid token before upgrading', async () => {
    await setup();
    await expect(TestAgent.connect(server.url, null)).rejects.toThrow('status 401');
    await expect(TestAgent.connect(server.url, generateToken('lwyn_'))).rejects.toThrow(
      'status 401',
    );
    await expect(TestAgent.connect(server.url, 'lwy_not-an-agent-token')).rejects.toThrow(
      'status 401',
    );
  });

  it('joins with a join token, issues a credential and marks the node online', async () => {
    await setup();
    const { node, agent, credential } = await joined();
    expect(credential).toMatch(/^lwya_[0-9A-Za-z]{43}$/);
    expect(gateway.isOnline(node.id)).toBe(true);
    expect(memory.nodes.get(node.id)).toMatchObject({ status: 'online', joinTokenHash: null });
    expect(events).toContainEqual(
      expect.objectContaining({ topic: 'nodes', resourceId: node.id, data: { status: 'online' } }),
    );
    await eventually(() =>
      expect(recorded.calls).toContainEqual({
        method: 'onNodeOnline',
        nodeId: node.id,
        payload: undefined,
      }),
    );

    // The join token is single-use; the credential works.
    agent.close();
    await agent.closed;
    await expect(TestAgent.connect(server.url, node.joinToken)).rejects.toThrow('status 401');
    const again = await connect(credential ?? '');
    const ok = await again.handshake();
    expect(ok.payload).toMatchObject({ nodeId: node.id, protocolVersion: 1 });
    expect(ok.payload.credential).toBeUndefined();
  });

  it('refuses incompatible protocol versions with an error and close code 4426', async () => {
    await setup();
    const node = memory.addNode();
    const agent = await connect(node.joinToken);
    const helloId = agent.send('hello', helloPayload({ protocolVersion: 99 }));
    const error = await agent.next('error');
    expect(error).toMatchObject({ id: helloId, payload: { code: 'incompatible-protocol' } });
    expect((await agent.closed).code).toBe(AGENT_CLOSE_CODES.incompatibleProtocol);
    expect(gateway.isOnline(node.id)).toBe(false);
    expect(memory.nodes.get(node.id)?.joinTokenHash).not.toBeNull();
  });

  it('requires hello first and closes silent sockets', async () => {
    await setup({ helloMs: 100 });
    const node = memory.addNode();
    const first = await connect(node.joinToken);
    first.send('heartbeat', { sentAt: new Date().toISOString(), activeDeploymentIds: [] });
    expect((await first.next('error')).payload.code).toBe('invalid-message');
    expect((await first.closed).code).toBe(1008);

    const silent = await connect(node.joinToken);
    expect((await silent.closed).code).toBe(1008);
  });

  it('records heartbeats and ignores unknown message types', async () => {
    await setup();
    const { node, agent } = await joined();
    agent.send('future.thing', { anything: true });
    const deploymentId = generateId('dep');
    agent.send('heartbeat', {
      sentAt: new Date().toISOString(),
      activeDeploymentIds: [deploymentId],
    });
    await eventually(() => expect(memory.touches).toContain(node.id));
    await eventually(() =>
      expect(recorded.calls).toContainEqual({
        method: 'onHeartbeat',
        nodeId: node.id,
        payload: [deploymentId],
      }),
    );
    expect(gateway.isOnline(node.id)).toBe(true);
  });

  it('resolves deploy on the first reply and forwards progress, logs and results in order', async () => {
    await setup();
    const { node, agent } = await joined();
    const deploymentId = generateId('dep');
    const deployed = gateway.deploy(node.id, deployPayload(deploymentId));
    const request = await agent.next('deploy');
    expect(request.payload.deploymentId).toBe(deploymentId);

    agent.send('deployment.progress', { deploymentId, status: 'cloning' }, request.id);
    await expect(deployed).resolves.toBeUndefined();
    agent.send(
      'deployment.log',
      {
        deploymentId,
        lines: [{ seq: 0, timestamp: new Date().toISOString(), stream: 'stdout', line: 'hi' }],
      },
      request.id,
    );
    agent.send(
      'deployment.result',
      { deploymentId, outcome: 'succeeded', services: [] },
      request.id,
    );
    await eventually(() =>
      expect(recorded.calls.filter((c) => c.nodeId === node.id).map((c) => c.method)).toEqual([
        'onNodeOnline',
        'onProgress',
        'onLog',
        'onResult',
      ]),
    );
  });

  it('rejects requests to offline nodes, agent errors and timeouts', async () => {
    await setup({ deployAckMs: 100 });
    const offline = generateId('node');
    await expect(gateway.deploy(offline, deployPayload(generateId('dep')))).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    await expect(gateway.appStatus(offline, app)).rejects.toBeInstanceOf(AgentUnavailableError);

    const { node, agent } = await joined();
    const status = gateway.appStatus(node.id, app);
    const request = await agent.next('status');
    agent.send(
      'error',
      { code: 'not-implemented', message: 'later', retryable: false },
      request.id,
    );
    await expect(status).rejects.toMatchObject({
      name: 'AgentRequestError',
      code: 'not-implemented',
    });

    const deploy = gateway.deploy(node.id, deployPayload(generateId('dep')));
    await expect(deploy).rejects.toBeInstanceOf(AgentRequestError);
    await expect(deploy).rejects.toMatchObject({ code: 'timeout' });
  });

  it('answers status, stop and remove with the reported services', async () => {
    await setup();
    const { node, agent } = await joined();
    const services = [
      {
        service: 'web',
        containerId: 'abc',
        state: 'running' as const,
        health: null,
        publishedPorts: [],
      },
    ];
    const status = gateway.appStatus(node.id, app);
    const statusRequest = await agent.next('status');
    expect(statusRequest.payload).toEqual({ appId: app.id, slug: app.slug });
    agent.send('app.status', { appId: app.id, services }, statusRequest.id);
    await expect(status).resolves.toEqual(services);

    const stop = gateway.stopApp(node.id, app);
    agent.send('app.status', { appId: app.id, services: [] }, (await agent.next('stop')).id);
    await expect(stop).resolves.toEqual([]);

    const removed = gateway.removeApp(node.id, app, true);
    const removeRequest = await agent.next('remove');
    expect(removeRequest.payload.removeVolumes).toBe(true);
    agent.send('app.status', { appId: app.id, services: [] }, removeRequest.id);
    await expect(removed).resolves.toBeUndefined();
    await eventually(() =>
      expect(recorded.calls.filter((c) => c.method === 'onAppStatus')).toHaveLength(3),
    );
  });

  it('resolves a cancel when the deployment result arrives', async () => {
    await setup();
    const { node, agent } = await joined();
    const deploymentId = generateId('dep');
    const cancelled = gateway.cancelDeployment(node.id, deploymentId);
    const request = await agent.next('deployment.cancel');
    expect(request.payload).toEqual({ deploymentId });
    agent.send('deployment.result', { deploymentId, outcome: 'cancelled' }, 'deploy-request-id');
    await expect(cancelled).resolves.toBeUndefined();
  });

  it('streams logs until logs.end and stops streams on abort', async () => {
    await setup();
    const { node, agent } = await joined();
    const lines: string[] = [];
    const line = (text: string) => ({
      service: 'web',
      timestamp: new Date().toISOString(),
      stream: 'stdout',
      line: text,
    });

    const finished = gateway.streamLogs(
      node.id,
      { app, follow: false, tail: 10, service: 'web' },
      (l) => lines.push(l.line),
      new AbortController().signal,
    );
    const start = await agent.next('logs.start');
    expect(start.payload).toMatchObject({ appId: app.id, service: 'web', tail: 10, follow: false });
    agent.send('logs.chunk', { lines: [line('a'), line('b')] }, start.id);
    agent.send('logs.end', { reason: 'completed' }, start.id);
    await expect(finished).resolves.toBeUndefined();
    expect(lines).toEqual(['a', 'b']);

    const controller = new AbortController();
    const followed = gateway.streamLogs(
      node.id,
      { app, follow: true },
      () => {},
      controller.signal,
    );
    const second = await agent.next('logs.start');
    controller.abort();
    await expect(followed).resolves.toBeUndefined();
    expect((await agent.next('logs.stop')).payload).toEqual({ streamId: second.id });
  });

  it('marks the node offline when the socket closes and fails pending requests', async () => {
    await setup({ offlineGraceMs: 50 });
    const { node, agent } = await joined();
    const pending = gateway.appStatus(node.id, app);
    await agent.next('status');
    agent.close();
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
    await eventually(() => expect(memory.nodes.get(node.id)?.status).toBe('offline'));
    await eventually(() =>
      expect(recorded.calls).toContainEqual({
        method: 'onNodeOffline',
        nodeId: node.id,
        payload: undefined,
      }),
    );
    expect(gateway.isOnline(node.id)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ resourceId: node.id, data: { status: 'offline' } }),
    );
  });

  it('leaves deployments alone when the agent reconnects within the grace period', async () => {
    await setup({ offlineGraceMs: 300 });
    const { node, agent, credential } = await joined();
    agent.close();
    await eventually(() => expect(memory.nodes.get(node.id)?.status).toBe('offline'));
    const again = await connect(credential ?? '');
    await again.handshake();
    expect(gateway.isOnline(node.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(recorded.calls.some((c) => c.method === 'onNodeOffline')).toBe(false);
  });

  it('marks nodes offline after missing heartbeats', async () => {
    await setup({ offlineAfterMs: 150, sweepIntervalMs: 25 });
    const { node, agent } = await joined();
    expect((await agent.closed).code).toBe(AGENT_CLOSE_CODES.heartbeatTimeout);
    await eventually(() => expect(memory.nodes.get(node.id)?.status).toBe('offline'));
    expect(gateway.isOnline(node.id)).toBe(false);
  });

  it('keeps one socket per node: a new connection replaces the old one', async () => {
    await setup();
    const { node, agent, credential } = await joined();
    const second = await connect(credential ?? '');
    await second.handshake();
    expect((await agent.closed).code).toBe(AGENT_CLOSE_CODES.replaced);
    // The replaced socket's close must not mark the node offline.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.isOnline(node.id)).toBe(true);
    expect(memory.nodes.get(node.id)?.status).toBe('online');
    expect(recorded.calls.some((c) => c.method === 'onNodeOffline')).toBe(false);
  });

  it('pushes rotated credentials and disconnects revoked nodes', async () => {
    await setup();
    const { node, agent } = await joined();
    const rotated = generateToken('lwya_');
    expect(gateway.pushCredential(node.id, rotated)).toBe(true);
    expect((await agent.next('hello.ok')).payload.credential).toBe(rotated);

    gateway.disconnect(node.id, AGENT_CLOSE_CODES.revoked, 'credential revoked');
    expect((await agent.closed).code).toBe(AGENT_CLOSE_CODES.revoked);
    expect(gateway.pushCredential(node.id, rotated)).toBe(false);
  });

  it('marks nodes left online by a previous process offline on start', async () => {
    const store = memoryStore();
    const { id } = store.addNode();
    const node = store.nodes.get(id);
    if (node) node.status = 'online';
    const { sink, calls } = recordingSink();
    const deps = createTestDeps();
    const fresh = createAgentGateway({
      deps,
      sink,
      store: store.store,
      timeouts: { offlineGraceMs: 20 },
    });
    const onPublish = vi.fn();
    deps.events.subscribe(onPublish);
    await fresh.start();
    expect(store.nodes.get(id)?.status).toBe('offline');
    // The agent gets the grace period to reconnect before its deployments are failed.
    expect(calls).toEqual([]);
    await eventually(() =>
      expect(calls).toEqual([{ method: 'onNodeOffline', nodeId: id, payload: undefined }]),
    );
    fresh.stop();
    expect(onPublish).toHaveBeenCalledOnce();
    // Not part of this test's server lifecycle.
    memory = store;
    gateway = fresh;
    server = { url: '', close: () => Promise.resolve() };
  });
});
