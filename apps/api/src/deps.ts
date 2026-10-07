import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import type { AgentGateway } from './lib/agent-gateway.js';
import type { AuthResolver, Principal } from './lib/auth-context.js';
import type { SecretBox } from './lib/crypto.js';
import type { EventBus } from './lib/event-bus.js';
import type { Lifecycle } from './lib/lifecycle.js';

/** Shared infrastructure handed to every module's `register<Name>Routes(api, deps)`. */
export interface Deps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  /** AES-256-GCM for secrets at rest (key derived from LAUNCHWAY_SECRET_KEY). */
  readonly secrets: SecretBox;
  /** Resolves the caller from the session cookie or bearer token (auth module). */
  readonly auth: AuthResolver;
  /** In-process change feed behind `GET /events`. Publish after the transaction commits. */
  readonly events: EventBus;
  /** Shutdown signal; long-lived streams must end when it aborts. */
  readonly lifecycle: Lifecycle;
  /** Connected node agents (nodes module). Consumers: deployments, apps, edge. */
  readonly agents: AgentGateway;
  readonly version: string;
}

/** Per-request variables (`c.var.*`). */
export interface AppVariables {
  requestId: string;
  /** Child logger bound to the request id. */
  logger: Logger;
  /** Client IP after trusted-proxy handling; null when unknown. */
  clientIp: string | null;
  /** Authenticated caller, null for anonymous requests. Use requireRole()/getPrincipal(). */
  principal: Principal | null;
}

export interface AppEnv {
  Variables: AppVariables;
}

export type Api = OpenAPIHono<AppEnv>;
