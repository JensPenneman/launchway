import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type WebSocketServerLike } from '@hono/node-server';
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_WS_PATH,
  type HelloPayload,
  type ServerToAgentMessage,
} from '@slipway/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../../src/app.js';
import type { Deps } from '../../src/deps.js';

/** The API on an ephemeral port with WebSocket support, like src/server.ts. */
export async function startTestServer(
  deps: Deps,
): Promise<{ url: string; close(): Promise<void> }> {
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({
    fetch: createApp(deps).fetch,
    hostname: '127.0.0.1',
    port: 0,
    websocket: { server: wss as unknown as WebSocketServerLike },
  }) as Server;
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${AGENT_WS_PATH}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function helloPayload(overrides: Partial<HelloPayload> = {}): HelloPayload {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: '0.1.0-test',
    hostname: 'test-node',
    platform: { os: 'linux', arch: 'arm64' },
    lanIp: '192.168.1.20',
    docker: null,
    dockerError: 'no docker in tests',
    ...overrides,
  };
}

/** A scripted agent speaking the protocol from @slipway/contracts. */
export class TestAgent {
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #socket: WebSocket;
  readonly #inbox: ServerToAgentMessage[] = [];
  #waiters: (() => void)[] = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.on('message', (data) => {
      this.#inbox.push(JSON.parse(String(data)) as ServerToAgentMessage);
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  /** Connects; rejects with `Error("status <code>")` when the upgrade is refused. */
  static connect(url: string, token: string | null): Promise<TestAgent> {
    const socket = new WebSocket(url, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new TestAgent(socket)));
      socket.once('unexpected-response', (_request, response) => {
        reject(new Error(`status ${response.statusCode}`));
        socket.terminate();
      });
      socket.once('error', reject);
    });
  }

  send(type: string, payload: unknown, id: string = randomUUID()): string {
    this.#socket.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  sendRaw(data: string): void {
    this.#socket.send(data);
  }

  /** Next message of `type` (earlier messages of other types stay queued). */
  async next<T extends ServerToAgentMessage['type']>(
    type: T,
    timeoutMs = 3000,
  ): Promise<Extract<ServerToAgentMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#inbox.findIndex((message) => message.type === type);
      if (index >= 0) {
        return this.#inbox.splice(index, 1)[0] as Extract<ServerToAgentMessage, { type: T }>;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no ${type} message within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Sends hello and waits for hello.ok. */
  async handshake(overrides: Partial<HelloPayload> = {}) {
    this.send('hello', helloPayload(overrides));
    return this.next('hello.ok');
  }

  close(): void {
    this.#socket.close(1000, 'test done');
  }
}
