import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentToServerMessage,
  generateId,
  parseAgentToServerMessage,
} from '@slipway/contracts';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { AgentConnection } from './connection.js';
import { createAgentRuntime } from './runtime/agent-runtime.js';
import type { Runner } from './runtime/exec.js';

const logger = pino({ level: 'silent' });
const credential = `slpa_${'b'.repeat(43)}`;
const nodeId = generateId('node');

interface Harness {
  server: WebSocketServer;
  url: string;
  received: AgentToServerMessage[];
  authorizations: (string | undefined)[];
  sockets: WebSocket[];
}

async function startServer(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const harness: Harness = {
    server,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/ws`,
    received: [],
    authorizations: [],
    sockets: [],
  };
  server.on('connection', (socket, request) => {
    harness.sockets.push(socket);
    harness.authorizations.push(request.headers.authorization);
    socket.on('message', (data) => {
      const parsed = parseAgentToServerMessage(data.toString());
      if (!parsed.ok) throw new Error(parsed.error);
      harness.received.push(parsed.message);
      if (parsed.message.type === 'hello') {
        socket.send(
          JSON.stringify({
            id: parsed.message.id,
            type: 'hello.ok',
            payload: {
              protocolVersion: AGENT_PROTOCOL_VERSION,
              nodeId,
              serverVersion: '0.1.0',
              heartbeatIntervalMs: 25,
              credential,
            },
          }),
        );
      }
    });
  });
  return harness;
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('AgentConnection', () => {
  it('joins with the join token, stores the credential, heartbeats and answers requests', async () => {
    const harness = await startServer();
    let token = `slpn_${'a'.repeat(43)}`;
    const joined: string[] = [];
    const workspace = await mkdtemp(join(tmpdir(), 'slipway-agent-conn-'));
    const commands: string[][] = [];
    const run: Runner = async (_command, args) => {
      commands.push([...args]);
      return { code: 0, signal: null, stdout: '', aborted: false, timedOut: false };
    };
    const runtime = createAgentRuntime({
      logger,
      workspace,
      run,
      trySend: (message) => connection.connected && connection.send(message),
    });
    const connection: AgentConnection = new AgentConnection({
      url: harness.url,
      logger,
      token: () => token,
      hello: async () => ({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: '0.1.0',
        hostname: 'test-node',
        platform: { os: 'linux', arch: 'amd64' },
        lanIp: null,
        docker: null,
        dockerError: 'no docker in tests',
      }),
      onHelloOk: async (payload) => {
        if (payload.credential) {
          token = payload.credential;
          joined.push(payload.nodeId);
        }
      },
      onReady: () => runtime.onConnected(),
      onRequest: (message) => runtime.handle(message),
      backoff: { initialMs: 10, maxMs: 50 },
    });
    cleanups.push(async () => {
      await connection.stop();
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    });

    connection.start();
    await waitFor(() => connection.connected);
    expect(harness.authorizations[0]).toBe(`Bearer slpn_${'a'.repeat(43)}`);
    expect(harness.received[0]?.type).toBe('hello');
    expect(joined).toEqual([nodeId]);

    await waitFor(() => harness.received.some((m) => m.type === 'heartbeat'));

    const socket = harness.sockets[0];
    const appId = generateId('app');
    socket?.send(JSON.stringify({ id: 'future-1', type: 'some.future.type', payload: {} }));
    socket?.send(
      JSON.stringify({
        id: 'req-7',
        type: 'status',
        payload: { appId, slug: 'trail' },
      }),
    );
    socket?.send(JSON.stringify({ id: 'req-8', type: 'logs.stop', payload: { streamId: 'nope' } }));
    await waitFor(() => harness.received.some((m) => m.type === 'app.status'));
    expect(harness.received.find((m) => m.type === 'app.status')).toEqual({
      id: 'req-7',
      type: 'app.status',
      payload: { appId, services: [] },
    });
    expect(commands[0]).toEqual(expect.arrayContaining(['-p', 'slipway-trail', 'ps', '--all']));
    await waitFor(() => harness.received.some((m) => m.type === 'error'));
    expect(harness.received.find((m) => m.type === 'error')).toMatchObject({
      id: 'req-8',
      payload: { code: 'not-found', retryable: false },
    });
    expect(harness.received.some((m) => m.id === 'future-1')).toBe(false);

    // Reconnect after the server drops the connection, now with the stored node credential.
    socket?.terminate();
    await waitFor(() => harness.authorizations.length === 2 && connection.connected);
    expect(harness.authorizations[1]).toBe(`Bearer ${credential}`);
  });
});
