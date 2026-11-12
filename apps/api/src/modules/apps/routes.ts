import { createRoute, z } from '@hono/zod-openapi';
import {
  App,
  AppId,
  AppListQuery,
  AppLogsQuery,
  AppPage,
  AppRuntimeStatus,
  CreateAppInput,
  DeleteAppQuery,
  EnvKey,
  EnvVar,
  EnvVarList,
  SetEnvVarsInput,
  UpdateAppInput,
  UpdateEnvVarInput,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { getPasskeySessionPrincipal, requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { conflict } from '../../lib/problem.js';
import { sseResponse } from '../../lib/sse.js';
import { createAutomationService } from '../automation/service.js';
import { assertMayChangeTrustedMounts, createAppsService } from './service.js';

const AppParams = z.object({ id: AppId });
const EnvParams = z.object({ id: AppId, key: EnvKey });
const TAGS = ['Apps'];

const createApp = createRoute({
  method: 'post',
  path: '/apps',
  operationId: 'createApp',
  tags: TAGS,
  summary: 'Create an app',
  description:
    'Links a repository of a GitHub connection to a node. `trustedMounts: true` requires the admin role (403 otherwise). While an app of the same ' +
    'repository has its automation on or in shadow, a passkey session is required (403 otherwise). ' +
    'Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { body: jsonBody(CreateAppInput) },
  responses: {
    201: jsonResponse(App, 'The new app'),
    ...problemResponses(400, 401, 403, 409),
  },
});

const listApps = createRoute({
  method: 'get',
  path: '/apps',
  operationId: 'listApps',
  tags: TAGS,
  summary: 'List apps (newest first)',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { query: AppListQuery },
  responses: {
    200: jsonResponse(AppPage, 'A page of apps'),
    ...problemResponses(400, 401, 403),
  },
});

const getApp = createRoute({
  method: 'get',
  path: '/apps/{id}',
  operationId: 'getApp',
  tags: TAGS,
  summary: 'Get an app',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams },
  responses: { 200: jsonResponse(App, 'The app'), ...problemResponses(401, 403, 404) },
});

const updateApp = createRoute({
  method: 'patch',
  path: '/apps/{id}',
  operationId: 'updateApp',
  tags: TAGS,
  summary: 'Update an app',
  description:
    'Partial update. Changing the source, connection or trustedMounts takes effect with the next ' +
    'deployment (an `apps` change event carries `redeployRequired`). Moving to another node ' +
    'requires the app to have no running or pending deployment and cancels its queued check ' +
    'runs. `previews` and `checks` are merged field by field (`checks.items` replaces the list). ' +
    'Setting `trustedMounts` requires the admin role (403 otherwise). While the automation of ' +
    'any app of the same repository is on or in shadow, changing `checks` or `connectionId` ' +
    'requires a passkey session (403 for tokens and password sessions). Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams, body: jsonBody(UpdateAppInput) },
  responses: {
    200: jsonResponse(App, 'The updated app'),
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

const deleteApp = createRoute({
  method: 'delete',
  path: '/apps/{id}',
  operationId: 'deleteApp',
  tags: TAGS,
  summary: 'Delete an app',
  description:
    'Cancels its check runs, removes the app from its node (`compose down`, `--volumes` with ' +
    'removeVolumes=true), then deletes it with its deployments, check runs and environment. ' +
    'Refused while the node is offline unless force=true. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams, query: DeleteAppQuery },
  responses: {
    204: { description: 'Deleted' },
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const listEnv = createRoute({
  method: 'get',
  path: '/apps/{id}/env',
  operationId: 'listAppEnv',
  tags: TAGS,
  summary: 'List the environment variables of an app',
  description: 'Values of secret variables are never returned (null).',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams },
  responses: {
    200: jsonResponse(EnvVarList, 'The variables, sorted by key'),
    ...problemResponses(401, 403, 404),
  },
});

const replaceEnv = createRoute({
  method: 'put',
  path: '/apps/{id}/env',
  operationId: 'replaceAppEnv',
  tags: TAGS,
  summary: 'Replace the environment of an app',
  description:
    'Sets exactly the given variables: missing keys are deleted, omitted values keep the stored ' +
    'value (so masked secrets can be round-tripped). Applies with the next deployment. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams, body: jsonBody(SetEnvVarsInput) },
  responses: {
    200: jsonResponse(EnvVarList, 'The new environment'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const setEnv = createRoute({
  method: 'put',
  path: '/apps/{id}/env/{key}',
  operationId: 'setAppEnvVar',
  tags: TAGS,
  summary: 'Create or update one environment variable',
  description: 'A new variable needs a value. Applies with the next deployment. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: EnvParams, body: jsonBody(UpdateEnvVarInput) },
  responses: {
    200: jsonResponse(EnvVar, 'The variable'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const deleteEnv = createRoute({
  method: 'delete',
  path: '/apps/{id}/env/{key}',
  operationId: 'deleteAppEnvVar',
  tags: TAGS,
  summary: 'Delete one environment variable',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: EnvParams },
  responses: { 204: { description: 'Deleted' }, ...problemResponses(401, 403, 404) },
});

const getStatus = createRoute({
  method: 'get',
  path: '/apps/{id}/status',
  operationId: 'getAppStatus',
  tags: TAGS,
  summary: 'Container status of an app',
  description: 'Live from the node; the last reported state when the node is offline.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams },
  responses: {
    200: jsonResponse(AppRuntimeStatus, 'The status'),
    ...problemResponses(401, 403, 404, 502),
  },
});

const stopApp = createRoute({
  method: 'post',
  path: '/apps/{id}/stop',
  operationId: 'stopApp',
  tags: TAGS,
  summary: 'Stop an app',
  description: '`compose stop` on the node; the running deployment becomes `stopped`. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams },
  responses: {
    200: jsonResponse(AppRuntimeStatus, 'The status after stopping'),
    ...problemResponses(401, 403, 404, 502, 503),
  },
});

const getLogs = createRoute({
  method: 'get',
  path: '/apps/{id}/logs',
  operationId: 'getAppLogs',
  tags: TAGS,
  summary: 'Stream container logs of an app (SSE)',
  description:
    'Server-Sent Events: `log` (AppLogLine) events, then `end` ({ reason }). With follow=true the ' +
    'stream stays open until the client disconnects or the server shuts down.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams, query: AppLogsQuery },
  responses: {
    200: {
      description: 'Event stream (see AppLogStreamEvent)',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...problemResponses(400, 401, 403, 404, 503),
  },
});

export function registerAppsRoutes(api: Api, deps: Deps): void {
  const service = createAppsService(deps);

  api.openapi(createApp, async (c) => {
    const body = c.req.valid('json');
    if (body.trustedMounts) assertMayChangeTrustedMounts(requestActor(c));
    // Commit status contexts are shared by every app of a repository: a second app there could
    // post the context an auto-merge waits for.
    if (
      await createAutomationService(deps).isRepositoryAutomated(
        body.repository.owner,
        body.repository.name,
      )
    ) {
      getPasskeySessionPrincipal(c);
    }
    return c.json(await service.create(body, requestActor(c)), 201);
  });
  api.openapi(listApps, async (c) => c.json(await service.list(c.req.valid('query')), 200));
  api.openapi(getApp, async (c) => c.json(await service.get(c.req.valid('param').id), 200));
  api.openapi(updateApp, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    // The checks are the gate an auto-merge relies on, and a PAT connection cannot write: while an
    // app of the repository is automated, changing either on any of its apps needs a passkey
    // session (T10: tokens read and pause).
    const automation = createAutomationService(deps);
    if (
      (body.checks !== undefined || body.connectionId !== undefined || body.nodeId !== undefined) &&
      (await automation.isRepositoryOfAppAutomated(id))
    ) {
      getPasskeySessionPrincipal(c);
    }
    // Stricter than the passkey gate: whatever the session, a sibling may not run checks whose
    // names an automated app's auto-merge waits for.
    if (body.checks !== undefined) {
      await automation.assertChecksChangeAllowed(id, body.checks);
    }
    return c.json(await service.update(id, body, requestActor(c)), 200);
  });
  api.openapi(deleteApp, async (c) => {
    const { id } = c.req.valid('param');
    // Deleting cascades the automation's records of what the App enabled, and lifts the gate of
    // the repository: it needs a passkey session and the App's auto-merges are withdrawn first.
    const automation = createAutomationService(deps);
    if (await automation.isAutomationLive(id)) {
      getPasskeySessionPrincipal(c);
      const swept = await automation.withdraw(id);
      if (swept.failed.length > 0) {
        throw conflict(
          `Could not withdraw the auto-merge of pull request ${swept.failed.map((n) => `#${n}`).join(', ')}; try again`,
        );
      }
    }
    await service.remove(id, c.req.valid('query'), requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(listEnv, async (c) => c.json(await service.listEnv(c.req.valid('param').id), 200));
  api.openapi(replaceEnv, async (c) =>
    c.json(
      await service.replaceEnv(c.req.valid('param').id, c.req.valid('json'), requestActor(c)),
      200,
    ),
  );
  api.openapi(setEnv, async (c) => {
    const { id, key } = c.req.valid('param');
    return c.json(await service.setEnv(id, key, c.req.valid('json'), requestActor(c)), 200);
  });
  api.openapi(deleteEnv, async (c) => {
    const { id, key } = c.req.valid('param');
    await service.deleteEnv(id, key, requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(getStatus, async (c) => c.json(await service.status(c.req.valid('param').id), 200));
  api.openapi(stopApp, async (c) =>
    c.json(await service.stop(c.req.valid('param').id, requestActor(c)), 200),
  );
  api.openapi(getLogs, async (c) => {
    const source = await service.openLogs(c.req.valid('param').id, c.req.valid('query'));
    const logger = c.get('logger');
    return sseResponse(c, source, {
      signal: deps.lifecycle.signal,
      onError: (error) => logger.error({ err: error }, 'app log stream failed'),
    });
  });
}
