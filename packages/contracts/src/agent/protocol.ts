import { z } from '../zod.js';

/**
 * Version of the agent <-> server protocol. Bump on breaking changes; the server refuses agents
 * whose `hello.protocolVersion` it does not support (error `incompatible-protocol`).
 */
export const AGENT_PROTOCOL_VERSION = 1;
export const SUPPORTED_AGENT_PROTOCOL_VERSIONS: readonly number[] = [AGENT_PROTOCOL_VERSION];

export function isSupportedProtocolVersion(version: number): boolean {
  return SUPPORTED_AGENT_PROTOCOL_VERSIONS.includes(version);
}

/**
 * WebSocket endpoint, relative to SLIPWAY_SERVER_URL. The upgrade request carries
 * `Authorization: Bearer <join token | node credential>`.
 */
export const AGENT_WS_PATH = '/api/agent/ws';
export const AGENT_HEARTBEAT_INTERVAL_MS = 15_000;
/** The server marks a node offline after this long without a heartbeat. */
export const NODE_OFFLINE_AFTER_MS = 45_000;

/** Application close codes (4000-4999) used on the agent socket. */
export const AGENT_CLOSE_CODES = {
  unauthorized: 4401,
  incompatibleProtocol: 4426,
  replaced: 4409,
  revoked: 4403,
} as const;

/** Correlation id. Requests carry a fresh id; replies echo the id of the request. */
export const MessageId = z.string().min(1).max(128);
export type MessageId = z.infer<typeof MessageId>;

export const AGENT_ERROR_CODES = [
  'not-implemented',
  'invalid-message',
  'incompatible-protocol',
  'unauthorized',
  'not-found',
  'busy',
  'policy-violation',
  'timeout',
  'internal-error',
] as const;
export const AgentErrorCode = z.enum(AGENT_ERROR_CODES);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;

export const AgentError = z.object({
  code: AgentErrorCode,
  message: z.string().max(2000),
  retryable: z.boolean(),
});
export type AgentError = z.infer<typeof AgentError>;
