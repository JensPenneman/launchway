import { createRoute } from '@hono/zod-openapi';
import { Settings, UpdateSettingsInput, UpdateSettingsResult } from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { getPasskeySessionPrincipal, requestActor, requireRole } from '../../lib/auth-context.js';
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
  description:
    'Partial update; `null` clears a value. At most one of `forwardAuthUrl` and `forwardAuthTarget` may be set. Changing either re-renders the edge; `hints` lists follow-ups such as an app that must be redeployed to attach the gate service. `notifyUrl` (write-only for tokens and viewers: they see `notifyUrlSet`) and `notifyToken` (write-only) need an admin session signed in with a passkey, not an API token or a password session. Requires the admin role. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { body: jsonBody(UpdateSettingsInput) },
  responses: {
    200: jsonResponse(UpdateSettingsResult, 'The updated settings and follow-up hints'),
    ...problemResponses(400, 401, 403, 409),
  },
});

export function registerSettingsRoutes(api: Api, deps: Deps): void {
  const service = createSettingsService(deps);

  api.openapi(getSettings, async (c) => c.json(await service.get(), 200));

  api.openapi(updateSettings, async (c) => {
    const input = c.req.valid('json');
    if (input.notifyUrl !== undefined || input.notifyToken !== undefined)
      getPasskeySessionPrincipal(c);
    const updated = await service.update(input, requestActor(c));
    return c.json(updated, 200);
  });
}
