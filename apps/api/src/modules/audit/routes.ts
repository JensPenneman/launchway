import { createRoute } from '@hono/zod-openapi';
import { AuditEventPage, AuditListQuery } from '@slipway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { listAuditEvents } from './service.js';

const listAudit = createRoute({
  method: 'get',
  path: '/audit',
  operationId: 'listAuditEvents',
  tags: ['Audit'],
  summary: 'List audit events',
  description:
    'Newest first, cursor-paginated. Filters: `action` (prefix), `actorId`, `targetType`, ' +
    '`targetId`, `since` (inclusive), `until` (exclusive). Requires the admin role.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { query: AuditListQuery },
  responses: {
    200: jsonResponse(AuditEventPage, 'A page of audit events'),
    ...problemResponses(400, 401, 403),
  },
});

export function registerAuditRoutes(api: Api, deps: Deps): void {
  api.openapi(listAudit, async (c) =>
    c.json(await listAuditEvents(deps.db, c.req.valid('query')), 200),
  );
}
