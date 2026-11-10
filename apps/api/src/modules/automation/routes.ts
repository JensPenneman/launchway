import { createRoute, z } from '@hono/zod-openapi';
import {
  AppId,
  AutomationChange,
  AutomationRunList,
  UpdateAppAutomation,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { getPasskeySessionPrincipal, requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createAutomationService } from './service.js';

const AppParams = z.object({ id: AppId });
const TAGS = ['Automation'];

const updateAutomation = createRoute({
  method: 'put',
  path: '/apps/{id}/automation',
  operationId: 'updateAppAutomation',
  tags: TAGS,
  summary: 'Change the automation settings of an app',
  description:
    'Partial update: omitted fields keep their value, `verify` is replaced as a whole. Pausing or ' +
    'moving `merge` away from `on` waits for the disable sweep (see the pause). Turning ' +
    '`merge` or `train` on (or to `shadow`) needs a GitHub App connection that is installed. ' +
    'Needs an admin session signed in with a passkey: API tokens and password sessions get 403. ' +
    'Audited. A 207 means the settings were saved but some auto-merges may still be on: check ' +
    '`sweep.failed` (clients such as `curl -f` treat 207 as success).',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: AppParams, body: jsonBody(UpdateAppAutomation) },
  responses: {
    200: jsonResponse(AutomationChange, 'The settings; `sweep` when auto-merges were withdrawn'),
    207: jsonResponse(
      AutomationChange,
      'Saved, but some auto-merges may still be on (`sweep.failed`)',
    ),
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

const pauseAutomation = createRoute({
  method: 'post',
  path: '/apps/{id}/automation/pause',
  operationId: 'pauseAppAutomation',
  tags: TAGS,
  summary: 'Pause the automation of an app',
  description:
    'Stops everything the automation would do next. The response comes after every auto-merge ' +
    'the GitHub App enabled was disabled (about 8 seconds at most); `sweep` lists the pull ' +
    'requests confirmed and failed, and the status is 207 when any failed (the reconcile keeps ' +
    'trying and sends an urgent notification). Check `sweep.failed` on a 207: clients such as ' +
    '`curl -f` treat it as success. Tokens with write scope may pause; only a passkey session ' +
    'resumes (through the settings). Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams },
  responses: {
    200: jsonResponse(AutomationChange, 'Paused; every App-enabled auto-merge was disabled'),
    207: jsonResponse(
      AutomationChange,
      'Paused, but some auto-merges may still be on (`sweep.failed`)',
    ),
    ...problemResponses(401, 403, 404),
  },
});

const listRuns = createRoute({
  method: 'get',
  path: '/apps/{id}/automation/runs',
  operationId: 'listAppAutomationRuns',
  tags: TAGS,
  summary: 'The last 20 automation runs of an app',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams },
  responses: {
    200: jsonResponse(AutomationRunList, 'The runs, newest first'),
    ...problemResponses(401, 403, 404),
  },
});

export function registerAutomationRoutes(api: Api, deps: Deps): void {
  const service = createAutomationService(deps);

  api.openapi(updateAutomation, async (c) => {
    getPasskeySessionPrincipal(c);
    const change = await service.update(
      c.req.valid('param').id,
      c.req.valid('json'),
      requestActor(c),
    );
    return change.sweep && change.sweep.failed.length > 0
      ? c.json(change, 207)
      : c.json(change, 200);
  });
  api.openapi(pauseAutomation, async (c) => {
    const change = await service.pause(c.req.valid('param').id, requestActor(c));
    return change.sweep && change.sweep.failed.length > 0
      ? c.json(change, 207)
      : c.json(change, 200);
  });
  api.openapi(listRuns, async (c) => {
    const id = c.req.valid('param').id;
    await service.get(id);
    return c.json({ items: await service.listRuns(id) }, 200);
  });
}
