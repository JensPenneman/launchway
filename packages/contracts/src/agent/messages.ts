import type { ZodType } from 'zod';
import { AppSlug, AppSource, EnvKey } from '../apps.js';
import {
  CommitSha,
  GitRef,
  IpAddress,
  Port,
  RoutableServiceName,
  ServiceName,
  Timestamp,
} from '../common.js';
import { AppLogLine, LogLine, ServiceStatus } from '../deployments.js';
import { AppId, DeploymentId, NodeId } from '../ids.js';
import { DockerInfo, NODE_CREDENTIAL_PATTERN } from '../nodes.js';
import { z } from '../zod.js';
import { AgentError, MessageId } from './protocol.js';

/** Every message is `{ id, type, payload }`. */
function message<T extends string, P extends ZodType>(type: T, payload: P) {
  return z.object({ id: MessageId, type: z.literal(type), payload });
}

// --- Agent -> server -------------------------------------------------------------------------

export const HelloPayload = z.object({
  protocolVersion: z.number().int().positive(),
  agentVersion: z.string().min(1).max(64),
  hostname: z.string().max(253),
  platform: z.object({ os: z.string().max(32), arch: z.string().max(32) }),
  lanIp: IpAddress.nullable(),
  docker: DockerInfo.nullable(),
  dockerError: z.string().max(2000).nullable().describe('Why the Docker probe failed, if it did'),
});
export type HelloPayload = z.infer<typeof HelloPayload>;

export const HeartbeatPayload = z.object({
  sentAt: Timestamp,
  activeDeploymentIds: z.array(DeploymentId).max(100),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>;

export const DeploymentProgressPayload = z.object({
  deploymentId: DeploymentId,
  status: z.enum(['cloning', 'building', 'starting']),
  message: z.string().max(2000).optional(),
});
export type DeploymentProgressPayload = z.infer<typeof DeploymentProgressPayload>;

export const DeploymentLogPayload = z.object({
  deploymentId: DeploymentId,
  lines: z.array(LogLine).min(1).max(500),
});
export type DeploymentLogPayload = z.infer<typeof DeploymentLogPayload>;

export const DeploymentResultPayload = z.discriminatedUnion('outcome', [
  z.object({
    deploymentId: DeploymentId,
    outcome: z.literal('succeeded'),
    services: z.array(ServiceStatus),
  }),
  z.object({ deploymentId: DeploymentId, outcome: z.literal('failed'), error: AgentError }),
  z.object({ deploymentId: DeploymentId, outcome: z.literal('cancelled') }),
]);
export type DeploymentResultPayload = z.infer<typeof DeploymentResultPayload>;

export const AppStatusPayload = z.object({ appId: AppId, services: z.array(ServiceStatus) });
export type AppStatusPayload = z.infer<typeof AppStatusPayload>;

export const LogsChunkPayload = z.object({ lines: z.array(AppLogLine).min(1).max(500) });
export type LogsChunkPayload = z.infer<typeof LogsChunkPayload>;

export const LogsEndPayload = z.object({
  reason: z.enum(['completed', 'stopped', 'error']),
  error: AgentError.optional(),
});
export type LogsEndPayload = z.infer<typeof LogsEndPayload>;

export const HelloMessage = message('hello', HelloPayload);
export const HeartbeatMessage = message('heartbeat', HeartbeatPayload);
export const DeploymentProgressMessage = message('deployment.progress', DeploymentProgressPayload);
export const DeploymentLogMessage = message('deployment.log', DeploymentLogPayload);
export const DeploymentResultMessage = message('deployment.result', DeploymentResultPayload);
export const AppStatusMessage = message('app.status', AppStatusPayload);
export const LogsChunkMessage = message('logs.chunk', LogsChunkPayload);
export const LogsEndMessage = message('logs.end', LogsEndPayload);
/** Failure reply to any server request (echoes its id), e.g. `not-implemented`. */
export const AgentErrorMessage = message('error', AgentError);

export const AgentToServerMessage = z.discriminatedUnion('type', [
  HelloMessage,
  HeartbeatMessage,
  DeploymentProgressMessage,
  DeploymentLogMessage,
  DeploymentResultMessage,
  AppStatusMessage,
  LogsChunkMessage,
  LogsEndMessage,
  AgentErrorMessage,
]);
export type AgentToServerMessage = z.infer<typeof AgentToServerMessage>;

// --- Server -> agent -------------------------------------------------------------------------

export const HelloOkPayload = z.object({
  protocolVersion: z.number().int().positive(),
  nodeId: NodeId,
  serverVersion: z.string().max(64),
  heartbeatIntervalMs: z.number().int().positive(),
  credential: z
    .string()
    .regex(NODE_CREDENTIAL_PATTERN)
    .optional()
    .describe('Issued once after joining with a join token; persist it (mode 0600)'),
});
export type HelloOkPayload = z.infer<typeof HelloOkPayload>;

/** A routed service: attached to the proxy network under `alias` (`<slug>-<service>`). */
export const DeployRoute = z.object({
  service: RoutableServiceName,
  port: Port,
  alias: z.string().min(1).max(63),
});
export type DeployRoute = z.infer<typeof DeployRoute>;

/**
 * Everything the agent needs for one deployment (spec sections 4 and 9). The agent clones
 * `source` into `<workspace>/apps/<appId>/<deploymentId>`, runs the Compose policy check, writes
 * `.env` (0600) from `env` and the override `compose.launchway.yaml` (proxy network + aliases for
 * `routes`, labels, LAN publishing when `network.publishOnIp` is set), then runs
 * `docker compose -p launchway-<slug> ... build --pull`, `pull`, `up -d --wait --remove-orphans`.
 */
export const DeployPayload = z.object({
  deploymentId: DeploymentId,
  app: z.object({ id: AppId, slug: AppSlug }),
  source: z.object({
    cloneUrl: z.url({ protocol: /^https$/ }),
    ref: GitRef,
    commitSha: CommitSha,
    authorization: z
      .string()
      .max(4096)
      .nullable()
      .describe(
        'Header value for git -c http.extraHeader="Authorization: <value>" (e.g. "basic <base64>"). Never logged or written to disk.',
      ),
  }),
  build: AppSource,
  env: z.record(EnvKey, z.string()).describe('Decrypted environment; never logged'),
  routes: z.array(DeployRoute).max(100),
  network: z.object({
    proxyNetwork: z.string().min(1).max(64),
    publishOnIp: IpAddress.nullable().describe(
      'LAN IP to publish routed ports on; null on the edge node',
    ),
  }),
});
export type DeployPayload = z.infer<typeof DeployPayload>;

export const DeploymentCancelPayload = z.object({ deploymentId: DeploymentId });
export type DeploymentCancelPayload = z.infer<typeof DeploymentCancelPayload>;

export const AppTargetPayload = z.object({ appId: AppId, slug: AppSlug });
export type AppTargetPayload = z.infer<typeof AppTargetPayload>;

export const RemovePayload = AppTargetPayload.extend({
  removeVolumes: z.boolean().describe('compose down --volumes (explicit "delete data" only)'),
});
export type RemovePayload = z.infer<typeof RemovePayload>;

export const LogsStartPayload = AppTargetPayload.extend({
  service: ServiceName.optional(),
  follow: z.boolean(),
  tail: z.number().int().min(0).max(10_000),
  since: Timestamp.optional(),
});
export type LogsStartPayload = z.infer<typeof LogsStartPayload>;

export const LogsStopPayload = z.object({
  streamId: MessageId.describe('id of the logs.start request'),
});
export type LogsStopPayload = z.infer<typeof LogsStopPayload>;

export const HelloOkMessage = message('hello.ok', HelloOkPayload);
/** Replies: deployment.progress / deployment.log / deployment.result, all echoing this id. */
export const DeployMessage = message('deploy', DeployPayload);
/** The running deploy ends with deployment.result (outcome cancelled); unknown id -> error not-found. */
export const DeploymentCancelMessage = message('deployment.cancel', DeploymentCancelPayload);
/** Reply: app.status. */
export const StopMessage = message('stop', AppTargetPayload);
/** Reply: app.status (no services). */
export const RemoveMessage = message('remove', RemovePayload);
/** Reply: app.status. */
export const StatusMessage = message('status', AppTargetPayload);
/** Replies: logs.chunk* then logs.end, echoing this id (the stream id). */
export const LogsStartMessage = message('logs.start', LogsStartPayload);
/** Ends the stream named in the payload; that stream answers with logs.end. */
export const LogsStopMessage = message('logs.stop', LogsStopPayload);
/** Refusal or failure, e.g. `incompatible-protocol` in reply to hello. */
export const ServerErrorMessage = message('error', AgentError);

export const ServerToAgentMessage = z.discriminatedUnion('type', [
  HelloOkMessage,
  DeployMessage,
  DeploymentCancelMessage,
  StopMessage,
  RemoveMessage,
  StatusMessage,
  LogsStartMessage,
  LogsStopMessage,
  ServerErrorMessage,
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessage>;

export type AgentToServerType = AgentToServerMessage['type'];
export type ServerToAgentType = ServerToAgentMessage['type'];

export const AGENT_TO_SERVER_TYPES = AgentToServerMessage.options.map(
  (option) => option.shape.type.value,
) as readonly AgentToServerType[];
export const SERVER_TO_AGENT_TYPES = ServerToAgentMessage.options.map(
  (option) => option.shape.type.value,
) as readonly ServerToAgentType[];

// --- Parsing ---------------------------------------------------------------------------------

const Envelope = z.object({ id: MessageId, type: z.string().min(1).max(64), payload: z.unknown() });

export type ParseFailureReason =
  | 'invalid-json'
  | 'invalid-envelope'
  | 'unknown-type'
  | 'invalid-payload';

export type ParseResult<T> =
  | { ok: true; message: T }
  | {
      ok: false;
      reason: ParseFailureReason;
      /** Present once the envelope parsed, so the receiver can reply with an `error`. */
      id?: string;
      type?: string;
      error: string;
    };

function createParser<T>(
  schema: ZodType<T>,
  knownTypes: readonly string[],
): (raw: string) => ParseResult<T> {
  const known = new Set(knownTypes);
  return (raw) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'invalid-json', error: 'Message is not valid JSON' };
    }
    const envelope = Envelope.safeParse(json);
    if (!envelope.success) {
      return { ok: false, reason: 'invalid-envelope', error: z.prettifyError(envelope.error) };
    }
    const { id, type } = envelope.data;
    if (!known.has(type)) {
      // Forward compatibility: callers log a warning and ignore the message.
      return {
        ok: false,
        reason: 'unknown-type',
        id,
        type,
        error: `Unknown message type "${type}"`,
      };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-payload',
        id,
        type,
        error: z.prettifyError(parsed.error),
      };
    }
    return { ok: true, message: parsed.data };
  };
}

/** Parses a frame received by the server. */
export const parseAgentToServerMessage = createParser(AgentToServerMessage, AGENT_TO_SERVER_TYPES);
/** Parses a frame received by the agent. */
export const parseServerToAgentMessage = createParser(ServerToAgentMessage, SERVER_TO_AGENT_TYPES);
