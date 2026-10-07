import { randomUUID } from 'node:crypto';
import {
  AGENT_CLOSE_CODES,
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_PROTOCOL_VERSION,
  type AgentError,
  type AgentToServerMessage,
  type AppLogLine,
  type DeploymentId,
  type DeployPayload,
  type HelloPayload,
  isSupportedProtocolVersion,
  NODE_OFFLINE_AFTER_MS,
  type NodeId,
  parseAgentToServerMessage,
  type ServerToAgentMessage,
  type ServiceStatus,
  SUPPORTED_AGENT_PROTOCOL_VERSIONS,
} from '@slipway/contracts';
import type { Logger } from 'pino';
import type { Deps } from '../../deps.js';
import {
  type AgentGateway,
  AgentRequestError,
  AgentUnavailableError,
  type AppTarget,
  type DeploymentSink,
  type LogsRequest,
} from '../../lib/agent-gateway.js';
import { type AgentAuth, createNodeAgentStore, type NodeAgentStore } from './agent-store.js';

/** Minimal view of a server-side WebSocket (hono's WSContext and `ws` both fit). */
export interface AgentSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Callbacks the WebSocket route forwards to the gateway for one accepted socket. */
export interface AgentConnectionHandlers {
  onMessage(data: unknown): void;
  onClose(): void;
}

export interface GatewayTimeouts {
  /** First reply to `deploy` (progress, log or result). */
  deployAckMs: number;
  /** `status` request. */
  statusMs: number;
  /** `stop` / `remove` (Compose may wait for containers to stop). */
  stopMs: number;
  /** `deployment.cancel`: until the deployment's result (or an error) arrives. */
  cancelMs: number;
  /** Time a new socket has to send `hello`. */
  helloMs: number;
  /** A node without heartbeat for this long is offline. */
  offlineAfterMs: number;
  /**
   * How long a disconnected node may take to reconnect before its in-progress deployments are
   * failed. The agent keeps running them while its socket is down and replays their reports.
   */
  offlineGraceMs: number;
  /** How often the offline sweep runs. */
  sweepIntervalMs: number;
}

const DEFAULT_TIMEOUTS: GatewayTimeouts = {
  deployAckMs: 30_000,
  statusMs: 30_000,
  stopMs: 120_000,
  cancelMs: 30_000,
  helloMs: 10_000,
  offlineAfterMs: NODE_OFFLINE_AFTER_MS,
  offlineGraceMs: NODE_OFFLINE_AFTER_MS,
  sweepIntervalMs: 5_000,
};
/** Attempts to hand a deployment result to the sink (transient database errors). */
const RESULT_DELIVERY_ATTEMPTS = 4;

const DEFAULT_LOG_TAIL = 200;
/** Standard close code for protocol violations. */
const POLICY_VIOLATION = 1008;

type GatewayDeps = Pick<Deps, 'logger' | 'events' | 'lifecycle' | 'version'> &
  Partial<Pick<Deps, 'db'>>;

export interface CreateAgentGatewayOptions {
  deps: GatewayDeps;
  sink: DeploymentSink;
  /** Persistence of node state; defaults to the PostgreSQL store (needs `deps.db`). */
  store?: NodeAgentStore;
  timeouts?: Partial<GatewayTimeouts>;
}

type OutgoingMessage = Exclude<ServerToAgentMessage, { type: 'hello.ok' | 'error' }>;
type Outgoing = {
  [K in OutgoingMessage['type']]: Extract<OutgoingMessage, { type: K }>['payload'];
};

type PendingKind = 'deploy' | 'cancel' | 'status' | 'stop' | 'remove';

interface Pending {
  readonly connection: Connection;
  readonly kind: PendingKind;
  readonly deploymentId?: DeploymentId;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface LogStream {
  readonly connection: Connection;
  readonly onLine: (line: AppLogLine) => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

class Connection {
  state: 'awaiting-hello' | 'handshaking' | 'ready' | 'closed' = 'awaiting-hello';
  lastSeen = Date.now();
  helloTimer: NodeJS.Timeout | undefined;
  /** Sink deliveries of this connection, in arrival order. */
  sinkChain: Promise<void> = Promise.resolve();

  readonly auth: AgentAuth;
  readonly socket: AgentSocket;

  constructor(auth: AgentAuth, socket: AgentSocket) {
    this.auth = auth;
    this.socket = socket;
  }

  get nodeId(): NodeId {
    return this.auth.nodeId;
  }

  /** Read through a method so checks after an await are not narrowed away. */
  isClosed(): boolean {
    return this.state === 'closed';
  }
}

/**
 * Creates the WebSocket gateway to node agents. Register the returned object as `Deps.agents`;
 * the agent socket route (`GET /api/agent/ws`) hands accepted sockets to it.
 */
export function createAgentGateway(options: CreateAgentGatewayOptions): NodeAgentGateway {
  return new NodeAgentGateway(options);
}

/** The control plane's side of the agent protocol (spec section 9). */
export class NodeAgentGateway implements AgentGateway {
  readonly #log: Logger;
  readonly #deps: GatewayDeps;
  readonly #sink: DeploymentSink;
  readonly #store: NodeAgentStore;
  readonly #timeouts: GatewayTimeouts;
  /** The live, handshaken connection per node. */
  readonly #connections = new Map<NodeId, Connection>();
  readonly #pending = new Map<string, Pending>();
  readonly #streams = new Map<string, LogStream>();
  /** Serializes status writes per node (handshake vs. offline marking). */
  readonly #nodeQueues = new Map<NodeId, Promise<void>>();
  /** Nodes that disconnected and have until the timer fires to come back. */
  readonly #offlineTimers = new Map<NodeId, NodeJS.Timeout>();
  #sweepTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: CreateAgentGatewayOptions) {
    this.#deps = options.deps;
    this.#log = options.deps.logger.child({ component: 'agent-gateway' });
    this.#sink = options.sink;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    if (options.store) this.#store = options.store;
    else if (options.deps.db) this.#store = createNodeAgentStore({ db: options.deps.db });
    else throw new Error('createAgentGateway needs deps.db or a store');
  }

  /**
   * Marks nodes left `online` by a previous process offline (no socket survives a restart) and
   * starts the heartbeat sweep. Their agents get the grace period to reconnect before their
   * deployments are failed. Stops with the process lifecycle.
   */
  async start(): Promise<void> {
    const stale = await this.#store.markAllOffline();
    for (const nodeId of stale) {
      this.#deps.events.publish({
        topic: 'nodes',
        action: 'updated',
        resourceId: nodeId,
        data: { status: 'offline' },
      });
      this.#scheduleOffline(nodeId);
    }
    this.#sweepTimer = setInterval(() => this.#sweep(), this.#timeouts.sweepIntervalMs);
    this.#sweepTimer.unref();
    this.#deps.lifecycle.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  /** Stops the sweep and closes every agent socket (process shutdown). */
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    for (const connection of [...this.#connections.values()]) {
      this.#closeSocket(connection, 1001, 'server shutting down');
      this.#disconnected(connection);
    }
    // Shutting down is not the nodes going away: leave their deployments to the next process.
    for (const timer of this.#offlineTimers.values()) clearTimeout(timer);
    this.#offlineTimers.clear();
  }

  /** Resolves a bearer token of the upgrade request; null when it is not valid. */
  authenticate(token: string): Promise<AgentAuth | null> {
    return this.#store.authenticate(token);
  }

  /** Accepts an authenticated socket; the caller forwards messages and the close event. */
  accept(auth: AgentAuth, socket: AgentSocket): AgentConnectionHandlers {
    const connection = new Connection(auth, socket);
    connection.helloTimer = setTimeout(() => {
      if (connection.state !== 'awaiting-hello') return;
      this.#log.warn({ nodeId: auth.nodeId }, 'agent sent no hello in time');
      this.#closeSocket(connection, POLICY_VIOLATION, 'hello expected');
      this.#disconnected(connection);
    }, this.#timeouts.helloMs);
    connection.helloTimer.unref();
    return {
      onMessage: (data) => this.#receive(connection, data),
      onClose: () => this.#disconnected(connection),
    };
  }

  isOnline(nodeId: NodeId): boolean {
    return this.#connections.get(nodeId)?.state === 'ready';
  }

  async deploy(nodeId: NodeId, payload: DeployPayload): Promise<void> {
    await this.#request(nodeId, 'deploy', payload, {
      kind: 'deploy',
      deploymentId: payload.deploymentId,
      timeoutMs: this.#timeouts.deployAckMs,
    });
  }

  async cancelDeployment(nodeId: NodeId, deploymentId: DeploymentId): Promise<void> {
    await this.#request(
      nodeId,
      'deployment.cancel',
      { deploymentId },
      { kind: 'cancel', deploymentId, timeoutMs: this.#timeouts.cancelMs },
    );
  }

  stopApp(nodeId: NodeId, app: AppTarget): Promise<ServiceStatus[]> {
    return this.#request<ServiceStatus[]>(
      nodeId,
      'stop',
      { appId: app.id, slug: app.slug },
      { kind: 'stop', timeoutMs: this.#timeouts.stopMs },
    );
  }

  async removeApp(nodeId: NodeId, app: AppTarget, removeVolumes: boolean): Promise<void> {
    await this.#request(
      nodeId,
      'remove',
      { appId: app.id, slug: app.slug, removeVolumes },
      { kind: 'remove', timeoutMs: this.#timeouts.stopMs },
    );
  }

  appStatus(nodeId: NodeId, app: AppTarget): Promise<ServiceStatus[]> {
    return this.#request<ServiceStatus[]>(
      nodeId,
      'status',
      { appId: app.id, slug: app.slug },
      { kind: 'status', timeoutMs: this.#timeouts.statusMs },
    );
  }

  streamLogs(
    nodeId: NodeId,
    request: LogsRequest,
    onLine: (line: AppLogLine) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const connection = this.#connections.get(nodeId);
    if (connection?.state !== 'ready') return Promise.reject(new AgentUnavailableError(nodeId));
    if (signal.aborted) return Promise.resolve();
    const streamId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        if (!this.#streams.delete(streamId)) return;
        this.#trySend(connection, { id: randomUUID(), type: 'logs.stop', payload: { streamId } });
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#streams.set(streamId, {
        connection,
        onLine,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      });
      const sent = this.#trySend(connection, {
        id: streamId,
        type: 'logs.start',
        payload: {
          appId: request.app.id,
          slug: request.app.slug,
          follow: request.follow,
          tail: request.tail ?? DEFAULT_LOG_TAIL,
          ...(request.service === undefined ? {} : { service: request.service }),
        },
      });
      if (!sent) this.#endStream(streamId, new AgentUnavailableError(nodeId));
    });
  }

  /**
   * Sends a new node credential to the connected agent (unsolicited `hello.ok`; the agent
   * persists any credential it receives). False when the node has no live socket.
   */
  pushCredential(nodeId: NodeId, credential: string): boolean {
    const connection = this.#connections.get(nodeId);
    if (connection?.state !== 'ready') return false;
    return this.#trySend(connection, this.#helloOk(connection, AGENT_PROTOCOL_VERSION, credential));
  }

  /** Closes the node's socket, e.g. after its credential was revoked. */
  disconnect(nodeId: NodeId, code: number, reason: string): void {
    const connection = this.#connections.get(nodeId);
    if (!connection) return;
    this.#closeSocket(connection, code, reason);
    this.#disconnected(connection);
  }

  // --- Incoming ---------------------------------------------------------------------------------

  #receive(connection: Connection, data: unknown): void {
    if (connection.state === 'closed') return;
    if (typeof data !== 'string') {
      this.#log.warn({ nodeId: connection.nodeId }, 'ignoring binary frame from agent');
      return;
    }
    const result = parseAgentToServerMessage(data);
    if (!result.ok) {
      if (result.reason === 'unknown-type') {
        this.#log.warn({ nodeId: connection.nodeId, type: result.type }, 'ignoring unknown type');
        return;
      }
      this.#log.warn(
        {
          nodeId: connection.nodeId,
          reason: result.reason,
          type: result.type,
          error: result.error,
        },
        'invalid message from agent',
      );
      if (result.id) {
        this.#sendError(connection, result.id, {
          code: 'invalid-message',
          message: result.error.slice(0, 2000),
          retryable: false,
        });
      }
      if (connection.state === 'awaiting-hello') {
        this.#closeSocket(connection, POLICY_VIOLATION, 'hello expected');
        this.#disconnected(connection);
      }
      return;
    }
    const message = result.message;
    if (connection.state === 'awaiting-hello') {
      if (message.type !== 'hello') {
        this.#sendError(connection, message.id, {
          code: 'invalid-message',
          message: 'The first message must be hello',
          retryable: false,
        });
        this.#closeSocket(connection, POLICY_VIOLATION, 'hello expected');
        this.#disconnected(connection);
        return;
      }
      this.#hello(connection, message.id, message.payload);
      return;
    }
    if (connection.state !== 'ready') {
      this.#log.warn(
        { nodeId: connection.nodeId, type: message.type },
        'ignoring message during handshake',
      );
      return;
    }
    connection.lastSeen = Date.now();
    this.#dispatch(connection, message);
  }

  #hello(connection: Connection, helloId: string, hello: HelloPayload): void {
    clearTimeout(connection.helloTimer);
    const { nodeId } = connection;
    if (!isSupportedProtocolVersion(hello.protocolVersion)) {
      this.#log.warn(
        { nodeId, protocolVersion: hello.protocolVersion, agentVersion: hello.agentVersion },
        'refusing agent with an incompatible protocol version',
      );
      this.#sendError(connection, helloId, {
        code: 'incompatible-protocol',
        message: `Protocol version ${hello.protocolVersion} is not supported by this server (supported: ${SUPPORTED_AGENT_PROTOCOL_VERSIONS.join(', ')}). Use an agent of the same Slipway version as the control plane (${this.#deps.version}).`,
        retryable: false,
      });
      this.#closeSocket(
        connection,
        AGENT_CLOSE_CODES.incompatibleProtocol,
        'incompatible protocol',
      );
      this.#disconnected(connection);
      return;
    }
    connection.state = 'handshaking';
    this.#enqueue(nodeId, async () => {
      if (connection.isClosed()) return;
      let outcome: Awaited<ReturnType<NodeAgentStore['completeHandshake']>>;
      try {
        outcome = await this.#store.completeHandshake(connection.auth, hello);
      } catch (error) {
        this.#log.error({ err: error, nodeId }, 'agent handshake failed');
        this.#sendError(connection, helloId, {
          code: 'internal-error',
          message: 'The server could not complete the handshake',
          retryable: true,
        });
        this.#closeSocket(connection, 1011, 'handshake failed');
        this.#disconnected(connection);
        return;
      }
      if (connection.isClosed()) return;
      if (!outcome.ok) {
        this.#log.warn({ nodeId }, 'agent credential no longer valid at hello');
        this.#sendError(connection, helloId, {
          code: 'unauthorized',
          message: 'The join token or node credential is no longer valid',
          retryable: false,
        });
        this.#closeSocket(connection, AGENT_CLOSE_CODES.unauthorized, 'unauthorized');
        this.#disconnected(connection);
        return;
      }
      const previous = this.#connections.get(nodeId);
      if (previous && previous !== connection) {
        this.#log.info({ nodeId }, 'a new agent connection replaces the previous one');
        this.#closeSocket(previous, AGENT_CLOSE_CODES.replaced, 'replaced by a new connection');
        this.#retire(previous);
      }
      connection.state = 'ready';
      connection.lastSeen = Date.now();
      this.#connections.set(nodeId, connection);
      clearTimeout(this.#offlineTimers.get(nodeId));
      this.#offlineTimers.delete(nodeId);
      this.#trySend(
        connection,
        this.#helloOk(connection, hello.protocolVersion, outcome.credential ?? undefined),
      );
      this.#log.info(
        { nodeId, agentVersion: hello.agentVersion, joined: outcome.credential !== null },
        'agent connected',
      );
      this.#deps.events.publish({
        topic: 'nodes',
        action: 'updated',
        resourceId: nodeId,
        data: { status: 'online' },
      });
      const onNodeOnline = this.#sink.onNodeOnline?.bind(this.#sink);
      if (onNodeOnline) await this.#deliver(() => onNodeOnline(nodeId), 'onNodeOnline', nodeId);
    });
  }

  #dispatch(connection: Connection, message: AgentToServerMessage): void {
    const { nodeId } = connection;
    switch (message.type) {
      case 'hello':
        this.#log.warn({ nodeId }, 'ignoring repeated hello');
        return;
      case 'heartbeat': {
        this.#store.touch(nodeId, new Date()).catch((error: unknown) => {
          this.#log.error({ err: error, nodeId }, 'failed to record heartbeat');
        });
        const onHeartbeat = this.#sink.onHeartbeat?.bind(this.#sink);
        if (onHeartbeat) {
          const active = message.payload.activeDeploymentIds;
          this.#forward(connection, 'onHeartbeat', () => onHeartbeat(nodeId, active));
        }
        return;
      }
      case 'deployment.progress':
        this.#settle(connection, message.id, 'deploy', undefined);
        this.#forward(connection, 'onProgress', () =>
          this.#sink.onProgress(nodeId, message.payload),
        );
        return;
      case 'deployment.log':
        this.#settle(connection, message.id, 'deploy', undefined);
        this.#forward(connection, 'onLog', () => this.#sink.onLog(nodeId, message.payload));
        return;
      case 'deployment.result':
        this.#settle(connection, message.id, 'deploy', undefined);
        for (const [id, pending] of this.#pending) {
          if (
            pending.kind === 'cancel' &&
            pending.connection === connection &&
            pending.deploymentId === message.payload.deploymentId
          ) {
            this.#settle(connection, id, 'cancel', undefined);
          }
        }
        this.#forward(
          connection,
          'onResult',
          () => this.#sink.onResult(nodeId, message.payload),
          RESULT_DELIVERY_ATTEMPTS,
        );
        return;
      case 'app.status': {
        const kind = this.#pending.get(message.id)?.kind;
        if (kind === 'status' || kind === 'stop') {
          this.#settle(connection, message.id, kind, message.payload.services);
        } else if (kind === 'remove') {
          this.#settle(connection, message.id, kind, undefined);
        }
        this.#forward(connection, 'onAppStatus', () =>
          this.#sink.onAppStatus(nodeId, message.payload),
        );
        return;
      }
      case 'logs.chunk': {
        const stream = this.#streams.get(message.id);
        if (stream?.connection !== connection) return;
        for (const line of message.payload.lines) {
          try {
            stream.onLine(line);
          } catch (error) {
            this.#log.warn({ err: error, nodeId }, 'log stream consumer failed');
          }
        }
        return;
      }
      case 'logs.end': {
        const { reason, error } = message.payload;
        this.#endStream(
          message.id,
          reason === 'error'
            ? new AgentRequestError(
                nodeId,
                error?.code ?? 'internal-error',
                error?.message ?? 'The log stream failed',
                error?.retryable ?? false,
              )
            : undefined,
        );
        return;
      }
      case 'error': {
        const failure = new AgentRequestError(
          nodeId,
          message.payload.code,
          message.payload.message,
          message.payload.retryable,
        );
        const pending = this.#pending.get(message.id);
        if (pending?.connection === connection) {
          this.#finish(message.id, pending);
          pending.reject(failure);
          return;
        }
        if (this.#streams.get(message.id)?.connection === connection) {
          this.#endStream(message.id, failure);
          return;
        }
        this.#log.warn({ nodeId, code: message.payload.code }, 'agent reported an error');
        return;
      }
    }
  }

  // --- Outgoing ---------------------------------------------------------------------------------

  #request<T>(
    nodeId: NodeId,
    type: keyof Outgoing,
    payload: Outgoing[keyof Outgoing],
    options: { kind: PendingKind; deploymentId?: DeploymentId; timeoutMs: number },
  ): Promise<T> {
    const connection = this.#connections.get(nodeId);
    if (connection?.state !== 'ready') return Promise.reject(new AgentUnavailableError(nodeId));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#finish(id, pending);
        reject(
          new AgentRequestError(
            nodeId,
            'timeout',
            `The agent did not answer "${type}" within ${Math.round(options.timeoutMs / 1000)} s`,
            true,
          ),
        );
      }, options.timeoutMs);
      timer.unref();
      this.#pending.set(id, {
        connection,
        kind: options.kind,
        ...(options.deploymentId === undefined ? {} : { deploymentId: options.deploymentId }),
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      const message = { id, type, payload } as ServerToAgentMessage;
      if (!this.#trySend(connection, message)) {
        const pending = this.#pending.get(id);
        if (pending) this.#finish(id, pending);
        reject(new AgentUnavailableError(nodeId));
      }
    });
  }

  #helloOk(
    connection: Connection,
    protocolVersion: number,
    credential: string | undefined,
  ): ServerToAgentMessage {
    return {
      id: randomUUID(),
      type: 'hello.ok',
      payload: {
        protocolVersion,
        nodeId: connection.nodeId,
        serverVersion: this.#deps.version.slice(0, 64),
        heartbeatIntervalMs: AGENT_HEARTBEAT_INTERVAL_MS,
        ...(credential === undefined ? {} : { credential }),
      },
    };
  }

  #sendError(connection: Connection, id: string, error: AgentError): void {
    this.#trySend(connection, { id, type: 'error', payload: error });
  }

  #trySend(connection: Connection, message: ServerToAgentMessage): boolean {
    if (connection.state === 'closed') return false;
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.#log.warn({ err: error, nodeId: connection.nodeId }, 'failed to send to agent');
      return false;
    }
  }

  // --- Bookkeeping ------------------------------------------------------------------------------

  /** Resolves the pending request `id` when it is of `kind`; true when it did. */
  #settle(connection: Connection, id: string, kind: PendingKind, value: unknown): boolean {
    const pending = this.#pending.get(id);
    if (pending?.kind !== kind || pending.connection !== connection) return false;
    this.#finish(id, pending);
    pending.resolve(value);
    return true;
  }

  #finish(id: string, pending: Pending): void {
    clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  #endStream(streamId: string, error: Error | undefined): void {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    this.#streams.delete(streamId);
    stream.cleanup();
    if (error) stream.reject(error);
    else stream.resolve();
  }

  #forward(connection: Connection, what: string, call: () => Promise<void>, attempts = 1): void {
    connection.sinkChain = connection.sinkChain.then(() =>
      this.#deliver(call, what, connection.nodeId, attempts),
    );
  }

  /** Calls the sink; retries with a short backoff when `attempts` > 1 (results must not drop). */
  async #deliver(
    call: () => Promise<void>,
    what: string,
    nodeId: NodeId,
    attempts = 1,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await call();
        return;
      } catch (error) {
        if (attempt >= attempts || this.#deps.lifecycle.shuttingDown) {
          this.#log.error({ err: error, nodeId, sink: what }, 'deployment sink failed');
          return;
        }
        this.#log.warn(
          { err: error, nodeId, sink: what, attempt },
          'deployment sink failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  /**
   * Fails the node's in-progress deployments unless it reconnects within the grace period: a
   * dropped socket does not stop the agent, which replays its reports after the next hello.
   */
  #scheduleOffline(nodeId: NodeId): void {
    if (this.#stopped) return;
    clearTimeout(this.#offlineTimers.get(nodeId));
    const timer = setTimeout(() => {
      if (this.#offlineTimers.get(nodeId) !== timer) return;
      this.#offlineTimers.delete(nodeId);
      this.#enqueue(nodeId, async () => {
        if (this.#connections.has(nodeId)) return;
        await this.#deliver(() => this.#sink.onNodeOffline(nodeId), 'onNodeOffline', nodeId);
      });
    }, this.#timeouts.offlineGraceMs);
    timer.unref();
    this.#offlineTimers.set(nodeId, timer);
  }

  #enqueue(nodeId: NodeId, task: () => Promise<void>): void {
    const previous = this.#nodeQueues.get(nodeId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.#log.error({ err: error, nodeId }, 'node state update failed');
    });
    this.#nodeQueues.set(nodeId, next);
    void next.then(() => {
      if (this.#nodeQueues.get(nodeId) === next) this.#nodeQueues.delete(nodeId);
    });
  }

  #closeSocket(connection: Connection, code: number, reason: string): void {
    try {
      connection.socket.close(code, reason);
    } catch (error) {
      this.#log.debug({ err: error, nodeId: connection.nodeId }, 'closing agent socket failed');
    }
  }

  /** Fails everything that waits on `connection` and marks it closed. */
  #retire(connection: Connection): void {
    if (connection.state === 'closed') return;
    connection.state = 'closed';
    clearTimeout(connection.helloTimer);
    const unavailable = new AgentUnavailableError(connection.nodeId);
    for (const [id, pending] of this.#pending) {
      if (pending.connection !== connection) continue;
      this.#finish(id, pending);
      pending.reject(unavailable);
    }
    for (const [streamId, stream] of this.#streams) {
      if (stream.connection === connection) this.#endStream(streamId, unavailable);
    }
  }

  /** The socket closed (or was closed by us): mark the node offline if it was the live one. */
  #disconnected(connection: Connection): void {
    if (connection.state === 'closed') return;
    this.#retire(connection);
    const { nodeId } = connection;
    if (this.#connections.get(nodeId) !== connection) return;
    this.#connections.delete(nodeId);
    this.#log.info({ nodeId }, 'agent disconnected');
    this.#enqueue(nodeId, async () => {
      if (this.#connections.has(nodeId)) return;
      await this.#store.markOffline(nodeId);
      this.#deps.events.publish({
        topic: 'nodes',
        action: 'updated',
        resourceId: nodeId,
        data: { status: 'offline' },
      });
      this.#scheduleOffline(nodeId);
    });
  }

  #sweep(): void {
    const deadline = Date.now() - this.#timeouts.offlineAfterMs;
    for (const connection of [...this.#connections.values()]) {
      if (connection.lastSeen >= deadline) continue;
      this.#log.warn({ nodeId: connection.nodeId }, 'no heartbeat from agent; marking offline');
      this.#closeSocket(connection, AGENT_CLOSE_CODES.heartbeatTimeout, 'heartbeat timeout');
      this.#disconnected(connection);
    }
  }
}
