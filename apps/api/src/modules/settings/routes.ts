import { createRoute } from '@hono/zod-openapi';
import { Settings, UpdateSettingsInput } from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createSettingsService } from './service.js';

const getSettings = createRoute({
  method: 'get',
  path: '/settings',
  operationId: 'getSettings',
  tags: ['Settings'],
  summary: 'Get the platform settings',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(Settings, 'Platform settings'),
    ...problemResponses(401, 403),
  },
});

const updateSettings = createRoute({
  method: 'patch',
  path: '/settings',
  operationId: 'updateSettings',
  tags: ['Settings'],
  summary: 'Update the platform settings',
  description: 'Partial update; `null` clears a value. Requires the admin role. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { body: jsonBody(UpdateSettingsInput) },
  responses: {
    200: jsonResponse(Settings, 'The updated settings'),
    ...problemResponses(400, 401, 403),
  },
});

export function registerSettingsRoutes(api: Api, deps: Deps): void {
  const service = createSettingsService(deps);

  api.openapi(getSettings, async (c) => c.json(await service.get(), 200));

  api.openapi(updateSettings, async (c) => {
    const updated = await service.update(c.req.valid('json'), requestActor(c));
    return c.json(updated, 200);
  });
}
