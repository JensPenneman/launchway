import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  Problem,
  SESSION_COOKIE_NAME,
} from '@slipway/contracts';
import type { ZodType } from 'zod';
import type { AppEnv } from '../deps.js';

/** `security` for routes that need a session cookie or an API token. */
export const AUTHENTICATED: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];
/** `security` for public routes (setup, sign-in, health, webhooks). */
export const PUBLIC: Array<Record<string, string[]>> = [];

export function registerSecuritySchemes(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE_NAME,
    description: 'Session cookie set by sign-in',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'API token (slp_...)',
  });
}

export function jsonResponse<T extends ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

export function jsonBody<T extends ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } };
}

const problemContent = { [PROBLEM_CONTENT_TYPE]: { schema: Problem } };

const DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request (validation-failed, bad-request)',
  401: 'Authentication required',
  403: 'Insufficient role or token scope',
  404: 'Resource not found',
  409: 'Conflict with the current state',
  410: 'Gone (expired)',
  429: PROBLEM_TYPES['rate-limited'].title,
  502: 'Upstream service failed',
  503: 'Service unavailable',
};

/** Documented problem responses, e.g. `...problemResponses(400, 401, 403)`. */
export function problemResponses<S extends number>(...statuses: S[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: DESCRIPTIONS[status] ?? 'Error', content: problemContent },
    ]),
  ) as Record<S, { description: string; content: typeof problemContent }>;
}

/** Top-level members of the OpenAPI 3.1 document served at /api/openapi.json. */
export function openApiObject(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Slipway API',
      version,
      description:
        'REST API of the Slipway control plane. Everything the web UI does goes through this API. ' +
        'Authenticate with the session cookie or `Authorization: Bearer slp_...`. Errors are RFC 9457 ' +
        'problem documents with stable `type` slugs; lists are cursor-paginated.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      {
        name: 'Auth',
        description: 'First-run setup, sign-in (password, passkeys) and the account',
      },
      { name: 'Users', description: 'Users and their roles' },
      { name: 'Invitations', description: 'Single-use invitation links' },
      { name: 'Tokens', description: 'API tokens for scripts and CI' },
      { name: 'Settings', description: 'Platform settings' },
      { name: 'Audit', description: 'Who changed what, when and from where' },
      { name: 'Events', description: 'Platform-wide change feed (Server-Sent Events)' },
      {
        name: 'GitHub',
        description: 'GitHub connections, repositories, releases, refs and webhooks',
      },
      { name: 'Apps', description: 'Apps, their environment, status, logs and lifecycle' },
      { name: 'Deployments', description: 'Deployments of a release or ref, with live logs' },
      { name: 'Nodes', description: 'Machines running the agent, join tokens and credentials' },
      { name: 'Domains', description: 'Domains Slipway serves and their DNS verification' },
      {
        name: 'Routes',
        description: 'What a domain serves: an app, an external upstream or a redirect',
      },
      { name: 'Edge', description: 'The rendered Caddy configuration and its load state' },
      { name: 'DNS', description: 'DNS provider accounts, zones, records and dynamic DNS' },
    ],
  };
}
