import type {
  AgentErrorCode,
  AppId,
  AppLogLine,
  AppStatusPayload,
  DeploymentId,
  DeploymentLogPayload,
  DeploymentProgressPayload,
  DeploymentResultPayload,
  DeployPayload,
  NodeId,
  ServiceStatus,
} from '@slipway/contracts';

/** The app a node-side command targets: enough to derive the Compose project name. @public */
export interface AppTarget {
  readonly id: AppId;
  readonly slug: string;
}

/** @public */
export interface LogsRequest {
  readonly app: AppTarget;
  /** Only this service's logs; all services when omitted. */
  readonly service?: string;
  /** Number of historical lines to send first. */
  readonly tail?: number;
  readonly follow: boolean;
}

/**
 * The control plane's view of connected node agents. Implemented by the nodes
 * module (WebSocket gateway); consumed by the deployments, apps and edge modules.
 *
 * Commands resolve when the agent acknowledged them, not when the work finished:
 * progress, logs and results arrive asynchronously through the `DeploymentSink`.
 * Every method rejects with `AgentUnavailableError` when the node is offline.
 */
export interface AgentGateway {
  isOnline(nodeId: NodeId): boolean;
  deploy(nodeId: NodeId, payload: DeployPayload): Promise<void>;
  cancelDeployment(nodeId: NodeId, deploymentId: DeploymentId): Promise<void>;
  /** `compose stop`; resolves with the resulting per-service status. */
  stopApp(nodeId: NodeId, app: AppTarget): Promise<ServiceStatus[]>;
  /** `compose down` (`--volumes` when `removeVolumes`); removes the checkouts too. */
  removeApp(nodeId: NodeId, app: AppTarget, removeVolumes: boolean): Promise<void>;
  appStatus(nodeId: NodeId, app: AppTarget): Promise<ServiceStatus[]>;
  /**
   * Streams container logs; `onLine` is called per line until the agent ends the
   * stream or `signal` aborts. Resolves when the stream ended.
   */
  streamLogs(
    nodeId: NodeId,
    request: LogsRequest,
    onLine: (line: AppLogLine) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Where the gateway delivers what agents report. Implemented by the deployments
 * module; the nodes module calls it for every matching agent message.
 * @public
 */
export interface DeploymentSink {
  onProgress(nodeId: NodeId, payload: DeploymentProgressPayload): Promise<void>;
  onLog(nodeId: NodeId, payload: DeploymentLogPayload): Promise<void>;
  onResult(nodeId: NodeId, payload: DeploymentResultPayload): Promise<void>;
  onAppStatus(nodeId: NodeId, payload: AppStatusPayload): Promise<void>;
  /**
   * The node lost its connection and did not come back within the grace period: in-flight
   * deployments on it must not stay in progress forever.
   */
  onNodeOffline(nodeId: NodeId): Promise<void>;
  /**
   * Optional: a heartbeat listed the deployments the agent still queues or runs. Lets the sink
   * settle deployments whose result was lost, and re-send claimed ones the agent never got.
   */
  onHeartbeat?(nodeId: NodeId, activeDeploymentIds: readonly DeploymentId[]): Promise<void>;
  /**
   * Optional: an agent completed its handshake (queued deployments for the node can be sent now).
   * Called after the node is marked online.
   */
  onNodeOnline?(nodeId: NodeId): Promise<void>;
}

/** Sink that drops every agent report (tests, and the deferred sink before it is bound). */
export const noopDeploymentSink: DeploymentSink = {
  onProgress: () => Promise.resolve(),
  onLog: () => Promise.resolve(),
  onResult: () => Promise.resolve(),
  onAppStatus: () => Promise.resolve(),
  onNodeOffline: () => Promise.resolve(),
};

/**
 * A sink that forwards every report to a target bound later. The deployments sink dispatches
 * queued deployments through the gateway while the gateway reports to the sink, so the
 * composition root creates the gateway with this forwarder and binds the real sink once the full
 * `Deps` exist. Until then reports are dropped (agents can only connect after the server listens).
 */
export function createDeferredDeploymentSink(): {
  readonly sink: DeploymentSink;
  bind(target: DeploymentSink): void;
} {
  let target: DeploymentSink = noopDeploymentSink;
  return {
    sink: {
      onProgress: (nodeId, payload) => target.onProgress(nodeId, payload),
      onLog: (nodeId, payload) => target.onLog(nodeId, payload),
      onResult: (nodeId, payload) => target.onResult(nodeId, payload),
      onAppStatus: (nodeId, payload) => target.onAppStatus(nodeId, payload),
      onNodeOffline: (nodeId) => target.onNodeOffline(nodeId),
      onNodeOnline: (nodeId) => target.onNodeOnline?.(nodeId) ?? Promise.resolve(),
      onHeartbeat: (nodeId, active) => target.onHeartbeat?.(nodeId, active) ?? Promise.resolve(),
    },
    bind(next) {
      target = next;
    },
  };
}

/** @public */
export class AgentUnavailableError extends Error {
  override readonly name = 'AgentUnavailableError';
  readonly nodeId: NodeId;

  constructor(nodeId: NodeId) {
    super(`node ${nodeId} has no connected agent`);
    this.nodeId = nodeId;
  }
}

/**
 * The agent answered a request with an `error` message (or did not answer in time: code
 * `timeout`), e.g. `not-found` for an unknown deployment or `policy-violation`.
 * @public
 */
export class AgentRequestError extends Error {
  override readonly name = 'AgentRequestError';
  readonly nodeId: NodeId;
  readonly code: AgentErrorCode;
  readonly retryable: boolean;

  constructor(nodeId: NodeId, code: AgentErrorCode, message: string, retryable: boolean) {
    super(message);
    this.nodeId = nodeId;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Placeholder used until the nodes module provides the real gateway. */
export function createUnavailableAgentGateway(): AgentGateway {
  const unavailable = (nodeId: NodeId): Promise<never> =>
    Promise.reject(new AgentUnavailableError(nodeId));
  return {
    isOnline: () => false,
    deploy: unavailable,
    cancelDeployment: unavailable,
    stopApp: unavailable,
    removeApp: unavailable,
    appStatus: unavailable,
    streamLogs: unavailable,
  };
}
