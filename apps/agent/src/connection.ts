import { randomUUID } from 'node:crypto';
import {
  AGENT_CLOSE_CODES,
  type AgentToServerMessage,
  type DeploymentId,
  type HelloOkPayload,
  type HelloPayload,
  parseServerToAgentMessage,
  type ServerToAgentMessage,
} from '@launchway/contracts';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { type BackoffOptions, backoffDelay, DEFAULT_BACKOFF } from './backoff.js';

type RequestMessage = Exclude<ServerToAgentMessage, { type: 'hello.ok' }>;

export interface AgentConnectionOptions {
  url: string;
  logger: Logger;
  /** Bearer token for the upgrade: the node credential, or the join token before joining. */
  token: () => string | null;
  hello: () => Promise<HelloPayload>;
  /** Called on `hello.ok`; persist `payload.credential` here when present. */
  onHelloOk: (payload: HelloOkPayload) => Promise<void>;
  /**
   * The server refused the token: HTTP 401 on the upgrade, or close code `unauthorized` after
   * `hello`. Called before the reconnect is scheduled, so `token()` may switch.
   */
  onRefused?: () => void;
  /** Called after each completed handshake (heartbeats running, `connected` is true). */
  onReady?: () => void;
  /** Server requests and errors received after the handshake. */
  onRequest: (message: RequestMessage) => void;
  activeDeployments?: () => DeploymentId[];
  backoff?: BackoffOptions;
  handshakeTimeoutMs?: number;
}

const CLOSE_REASONS: Record<number, string> = {
  [AGENT_CLOSE_CODES.unauthorized]: 'the server rejected the credential or join token',
  [AGENT_CLOSE_CODES.revoked]: 'the node credential was revoked',
  [AGENT_CLOSE_CODES.incompatibleProtocol]:
    'the server does not support this agent protocol version',
  [AGENT_CLOSE_CODES.replaced]: 'another agent connected as this node',
};

/**
 * Outbound WebSocket to the control plane (spec section 9): authenticates the upgrade with a
 * bearer token, sends `hello`, starts heartbeats after `hello.ok` and reconnects with exponential
 * backoff and jitter. Unknown message types are ignored with a warning.
 */
export class AgentConnection {
  readonly #options: AgentConnectionOptions;
  readonly #log: Logger;
  #socket: WebSocket | undefined;
  #attempt = 0;
  #ready = false;
  #stopped = true;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #heartbeatIntervalMs = 0;
  /** Last frame (message or pong) from the server; a silent peer means a half-open socket. */
  #lastFrameAt = 0;
  #handshakeTimer: NodeJS.Timeout | undefined;

  constructor(options: AgentConnectionOptions) {
    this.#options = options;
    this.#log = options.logger;
  }

  /** True between `hello.ok` and the next disconnect. */
  get connected(): boolean {
    return this.#ready;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => socket.terminate(), 5_000);
      socket.once('close', () => {
        clearTimeout(force);
        resolve();
      });
      socket.close(1000, 'agent shutting down');
    });
  }

  send(message: AgentToServerMessage): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  #connect(): void {
    if (this.#stopped) return;
    const token = this.#options.token();
    if (!token) {
      this.#log.error('no node credential or join token available; cannot connect');
      this.#scheduleReconnect();
      return;
    }
    this.#log.debug({ url: this.#options.url }, 'connecting to the control plane');
    const socket = new WebSocket(this.#options.url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
    });
    this.#socket = socket;
    socket.on('open', () => {
      this.#sendHello(socket).catch((err: unknown) => {
        this.#log.error({ err }, 'failed to send hello');
        socket.close(1011, 'hello failed');
      });
    });
    socket.on('pong', () => {
      this.#lastFrameAt = Date.now();
    });
    socket.on('message', (data, isBinary) => {
      this.#lastFrameAt = Date.now();
      if (isBinary) {
        this.#log.warn('ignoring binary frame');
        return;
      }
      this.#onMessage(data.toString());
    });
    socket.on('error', (err) => {
      this.#log.warn({ error: err.message }, 'agent socket error');
      // `ws` reports a refused upgrade as "Unexpected server response: <status>".
      if (/Unexpected server response: 401\b/.test(err.message)) this.#options.onRefused?.();
    });
    socket.on('close', (code, reason) => this.#onClose(socket, code, reason.toString()));
  }

  async #sendHello(socket: WebSocket): Promise<void> {
    const payload = await this.#options.hello();
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ id: randomUUID(), type: 'hello', payload }));
    this.#handshakeTimer = setTimeout(() => {
      this.#log.warn('no hello.ok received; reconnecting');
      socket.close(4000, 'handshake timeout');
    }, this.#options.handshakeTimeoutMs ?? 15_000);
  }

  #onMessage(raw: string): void {
    const result = parseServerToAgentMessage(raw);
    if (!result.ok) {
      if (result.reason === 'unknown-type') {
        this.#log.warn({ type: result.type }, 'ignoring unknown message type');
        return;
      }
      this.#log.warn(
        { reason: result.reason, type: result.type, error: result.error },
        'invalid message',
      );
      if (result.id) {
        this.send({
          id: result.id,
          type: 'error',
          payload: {
            code: 'invalid-message',
            message: result.error.slice(0, 2000),
            retryable: false,
          },
        });
      }
      return;
    }
    const message = result.message;
    if (message.type === 'hello.ok') {
      this.#onHelloOk(message.payload).catch((err: unknown) => {
        this.#log.error({ err }, 'failed to complete the handshake');
        this.#socket?.close(1011, 'handshake failed');
      });
      return;
    }
    if (!this.#ready && message.type !== 'error') {
      this.#log.warn({ type: message.type }, 'ignoring request received before hello.ok');
      return;
    }
    this.#options.onRequest(message);
  }

  async #onHelloOk(payload: HelloOkPayload): Promise<void> {
    clearTimeout(this.#handshakeTimer);
    await this.#options.onHelloOk(payload);
    this.#ready = true;
    this.#attempt = 0;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatIntervalMs = payload.heartbeatIntervalMs;
    this.#lastFrameAt = Date.now();
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), payload.heartbeatIntervalMs);
    this.#log.info(
      { nodeId: payload.nodeId, serverVersion: payload.serverVersion },
      'connected to the control plane',
    );
    this.#options.onReady?.();
  }

  #heartbeat(): void {
    const socket = this.#socket;
    if (!socket) return;
    // TCP alone may take ~15 minutes to notice a vanished peer (NAT expiry, dropped link).
    if (Date.now() - this.#lastFrameAt > 2.5 * this.#heartbeatIntervalMs) {
      this.#log.warn('no answer from the control plane; reconnecting');
      socket.terminate();
      return;
    }
    try {
      socket.ping();
    } catch {
      // Closing already; the close event reconnects.
    }
    this.send({
      id: randomUUID(),
      type: 'heartbeat',
      payload: {
        sentAt: new Date().toISOString(),
        activeDeploymentIds: this.#options.activeDeployments?.() ?? [],
      },
    });
  }

  #onClose(socket: WebSocket, code: number, reason: string): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#ready = false;
    clearInterval(this.#heartbeatTimer);
    clearTimeout(this.#handshakeTimer);
    if (this.#stopped) return;
    const explanation = CLOSE_REASONS[code];
    if (explanation) this.#log.error({ code, reason }, `disconnected: ${explanation}`);
    else this.#log.warn({ code, reason }, 'disconnected from the control plane');
    if (code === AGENT_CLOSE_CODES.unauthorized) this.#options.onRefused?.();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delayMs = backoffDelay(this.#attempt, this.#options.backoff ?? DEFAULT_BACKOFF);
    this.#attempt += 1;
    this.#log.info({ delayMs, attempt: this.#attempt }, 'reconnecting');
    this.#reconnectTimer = setTimeout(() => this.#connect(), delayMs);
  }
}
