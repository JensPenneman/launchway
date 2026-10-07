import { AGENT_WS_PATH, IpAddress, NODE_JOIN_TOKEN_PATTERN } from '@launchway/contracts';
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AgentConfig {
  /** Full WebSocket URL of the agent endpoint (`wss://host/api/agent/ws`). */
  readonly socketUrl: string;
  readonly joinToken: string | null;
  /** Explicit LAN IP; null = auto-detect. */
  readonly lanIp: string | null;
  readonly workspace: string;
  readonly dockerHost: string;
  readonly logLevel: LogLevel;
}

export class AgentConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid agent configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'AgentConfigError';
    this.issues = issues;
  }
}

/** Accepts ws(s):// or http(s):// base URLs and returns the agent socket URL. */
export function toSocketUrl(serverUrl: string): string {
  const url = new URL(AGENT_WS_PATH, serverUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

const EnvSchema = z.object({
  LAUNCHWAY_SERVER_URL: z.url({ protocol: /^(?:wss?|https?)$/ }),
  LAUNCHWAY_JOIN_TOKEN: z
    .string()
    .regex(NODE_JOIN_TOKEN_PATTERN, 'must be lwyn_ followed by 43 base62 characters')
    .optional(),
  LAUNCHWAY_NODE_LAN_IP: IpAddress.optional(),
  LAUNCHWAY_WORKSPACE: z.string().min(1).default('/var/lib/launchway'),
  DOCKER_HOST: z.string().min(1).default('unix:///var/run/docker.sock'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/** Parses the agent environment (spec section 13); empty values count as unset. */
export function loadAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const input = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    socketUrl: toSocketUrl(e.LAUNCHWAY_SERVER_URL),
    joinToken: e.LAUNCHWAY_JOIN_TOKEN ?? null,
    lanIp: e.LAUNCHWAY_NODE_LAN_IP ?? null,
    workspace: e.LAUNCHWAY_WORKSPACE,
    dockerHost: e.DOCKER_HOST,
    logLevel: e.LOG_LEVEL,
  };
}
