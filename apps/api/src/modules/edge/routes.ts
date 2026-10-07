import { createRoute } from '@hono/zod-openapi';
import { EdgeConfig } from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { edgeReconciler } from './reconciler.js';

const TAGS = ['Edge'];

const getEdgeConfig = createRoute({
  method: 'get',
  path: '/edge/config',
  operationId: 'getEdgeConfig',
  tags: TAGS,
  summary: 'Get the edge configuration',
  description:
    'The Caddyfile rendered from the current routes, the configuration last loaded into Caddy and the last load error. Read-only; requires the admin role.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  responses: {
    200: jsonResponse(EdgeConfig, 'Rendered and applied configuration'),
    ...problemResponses(401, 403),
  },
});

const reloadEdge = createRoute({
  method: 'post',
  path: '/edge/reload',
  operationId: 'reloadEdge',
  tags: TAGS,
  summary: 'Render and load the edge configuration now',
  description:
    'Validates the rendered Caddyfile with Caddy (`/adapt`) and loads it (`/load`), even when unchanged. Caddy errors are returned as `upstream-failed` (502) with its message, an unreachable admin API as `service-unavailable` (503). Requires the admin role.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  responses: {
    200: jsonResponse(EdgeConfig, 'The loaded configuration'),
    ...problemResponses(401, 403, 502, 503),
  },
});

export function registerEdgeRoutes(api: Api, deps: Deps): void {
  const reconciler = edgeReconciler(deps);

  api.openapi(getEdgeConfig, async (c) => c.json(await reconciler.config(), 200));

  api.openapi(reloadEdge, async (c) => c.json(await reconciler.apply({ force: true }), 200));
}
