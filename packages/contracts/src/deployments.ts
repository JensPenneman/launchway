import { CommitSha, GitRef, IpAddress, Port, ServiceName, Timestamp } from './common.js';
import { AppId, DeploymentId, NodeId, UserId } from './ids.js';
import { PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

// --- State machine (spec section 2) -------------------------------------------------------------

export const DEPLOYMENT_STATUSES = [
  'queued',
  'cloning',
  'building',
  'starting',
  'running',
  'superseded',
  'stopped',
  'failed',
  'cancelled',
] as const;
export const DeploymentStatus = z.enum(DEPLOYMENT_STATUSES).openapi('DeploymentStatus');
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

/**
 * Allowed transitions. In-progress states advance, fail or get cancelled; `running` is left
 * only by `superseded` (a newer deployment reached running) or `stopped`. Terminal states have
 * no exits. A rollback is a new deployment, never a transition. `building -> queued` is the
 * image retry: an automatic deployment whose image does not exist yet waits for its next attempt
 * (docs/adr/0019).
 */
export const DEPLOYMENT_TRANSITIONS = {
  queued: ['cloning', 'failed', 'cancelled'],
  cloning: ['building', 'failed', 'cancelled'],
  building: ['starting', 'failed', 'cancelled', 'queued'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['superseded', 'stopped'],
  superseded: [],
  stopped: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<DeploymentStatus, readonly DeploymentStatus[]>;

export const IN_PROGRESS_DEPLOYMENT_STATUSES = [
  'queued',
  'cloning',
  'building',
  'starting',
] as const;
export const TERMINAL_DEPLOYMENT_STATUSES = [
  'superseded',
  'stopped',
  'failed',
  'cancelled',
] as const;

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return (DEPLOYMENT_TRANSITIONS[from] as readonly DeploymentStatus[]).includes(to);
}

export class InvalidDeploymentTransitionError extends Error {
  readonly from: DeploymentStatus;
  readonly to: DeploymentStatus;
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Deployment cannot move from ${from} to ${to}`);
    this.name = 'InvalidDeploymentTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidDeploymentTransitionError(from, to);
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[status].length === 0;
}

export function isInProgressStatus(status: DeploymentStatus): boolean {
  return (IN_PROGRESS_DEPLOYMENT_STATUSES as readonly DeploymentStatus[]).includes(status);
}

/** A deployment addressed to an offline node fails after this long in `queued`. */
export const QUEUED_DEPLOYMENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Why a deployment failed, as classified by the agent: `image-not-found` (the registry does not
 * know an image or tag yet: manifest unknown, name unknown, 404), `policy` (Compose policy
 * refused the project), `build` (clone, build or pull failed otherwise), `start` (`up` failed or
 * a service did not become healthy) and `unknown`.
 */
export const DEPLOYMENT_FAILURE_REASONS = [
  'image-not-found',
  'policy',
  'build',
  'start',
  'unknown',
] as const;
export const DeploymentFailureReason = z
  .enum(DEPLOYMENT_FAILURE_REASONS)
  .openapi('DeploymentFailureReason');
export type DeploymentFailureReason = z.infer<typeof DeploymentFailureReason>;

// --- Runtime state reported by the agent -------------------------------------------------------

export const PublishedPort = z
  .object({
    containerPort: Port,
    hostPort: Port,
    protocol: z.enum(['tcp', 'udp']),
    hostIp: IpAddress.nullable(),
  })
  .openapi('PublishedPort');
export type PublishedPort = z.infer<typeof PublishedPort>;

export const CONTAINER_STATES = [
  'created',
  'running',
  'restarting',
  'exited',
  'paused',
  'dead',
  'removing',
] as const;
export const CONTAINER_HEALTH = ['healthy', 'unhealthy', 'starting'] as const;

export const ServiceStatus = z
  .object({
    service: z.string().min(1).max(128),
    containerId: z.string().nullable(),
    state: z.enum(CONTAINER_STATES),
    health: z
      .enum(CONTAINER_HEALTH)
      .nullable()
      .openapi({ description: 'null without a healthcheck' }),
    publishedPorts: z.array(PublishedPort),
  })
  .openapi('ServiceStatus');
export type ServiceStatus = z.infer<typeof ServiceStatus>;

// --- Deployment ----------------------------------------------------------------------------------

export const DEPLOYMENT_TRIGGERS = ['manual', 'auto'] as const;
export const DeploymentTrigger = z.enum(DEPLOYMENT_TRIGGERS).openapi('DeploymentTrigger', {
  description: 'manual: user/API request (incl. rollbacks); auto: release webhook or poll',
});
export type DeploymentTrigger = z.infer<typeof DeploymentTrigger>;

export const Deployment = z
  .object({
    id: DeploymentId,
    appId: AppId,
    nodeId: NodeId,
    ref: GitRef,
    commitSha: CommitSha,
    trigger: DeploymentTrigger,
    status: DeploymentStatus,
    statusMessage: z
      .string()
      .nullable()
      .openapi({ description: 'Failure reason or progress note' }),
    triggeredBy: UserId.nullable(),
    failureReason: DeploymentFailureReason.nullable().openapi({
      description:
        'Classified cause of the last failed attempt; set while an image retry waits, too',
    }),
    retryCount: z.number().int().min(0).openapi({
      description: 'Image retries scheduled so far (automatic deployments only)',
    }),
    nextAttemptAt: Timestamp.nullable().openapi({
      description: 'While queued for an image retry: when the next attempt is dispatched',
    }),
    services: z.array(ServiceStatus),
    createdAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
  })
  .openapi('Deployment');
export type Deployment = z.infer<typeof Deployment>;

export const DeploymentPage = page(Deployment).openapi('DeploymentPage');
export type DeploymentPage = z.infer<typeof DeploymentPage>;

export const DeploymentListQuery = PaginationQuery.extend({ status: DeploymentStatus.optional() });
export type DeploymentListQuery = z.infer<typeof DeploymentListQuery>;

export const CreateDeploymentInput = z
  .strictObject({
    ref: GitRef.openapi({
      description: 'Release tag, branch or commit; resolved to a SHA on creation',
    }),
  })
  .openapi('CreateDeploymentInput');
export type CreateDeploymentInput = z.infer<typeof CreateDeploymentInput>;

// --- Logs ----------------------------------------------------------------------------------------

export const LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;
export const LogStream = z.enum(LOG_STREAMS);
export type LogStream = z.infer<typeof LogStream>;

export const LogLine = z
  .object({
    seq: z.number().int().min(0).openapi({ description: 'Monotonic per deployment' }),
    timestamp: Timestamp,
    stream: LogStream,
    line: z.string().max(16_384),
  })
  .openapi('LogLine');
export type LogLine = z.infer<typeof LogLine>;

/** Line of an app's container logs (`GET /apps/{id}/logs`). */
export const AppLogLine = z
  .object({
    service: ServiceName,
    timestamp: Timestamp,
    stream: z.enum(['stdout', 'stderr']),
    line: z.string().max(16_384),
  })
  .openapi('AppLogLine');
export type AppLogLine = z.infer<typeof AppLogLine>;

export const DeploymentLogsQuery = z.object({
  follow: z.stringbool().default(false),
  after: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: 'Only lines with seq > after' }),
});
export type DeploymentLogsQuery = z.infer<typeof DeploymentLogsQuery>;
