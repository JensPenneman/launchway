import { createRoute, z } from '@hono/zod-openapi';
import {
  AppId,
  CheckLogsQuery,
  CheckRun,
  CheckRunId,
  CheckRunList,
  CheckRunListQuery,
  CheckRunPage,
  CreateCheckRunsInput,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { sseResponse } from '../../lib/sse.js';
import { createChecksService } from './service.js';

const AppParams = z.object({ id: AppId });
const CheckRunParams = z.object({ id: CheckRunId });
const TAGS = ['Checks'];

const listCheckRuns = createRoute({
  method: 'get',
  path: '/apps/{id}/checks',
  operationId: 'listCheckRuns',
  tags: TAGS,
  summary: 'List the check runs of an app (newest first)',
  description: 'Filter by status, check name or commit.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams, query: CheckRunListQuery },
  responses: {
    200: jsonResponse(CheckRunPage, 'A page of check runs'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const createCheckRuns = createRoute({
  method: 'post',
  path: '/apps/{id}/checks',
  operationId: 'createCheckRuns',
  tags: TAGS,
  summary: "Run an app's checks for a ref",
  description:
    'Resolves the ref (branch, tag or commit) to a commit and queues one run per check (every ' +
    "configured check, or the named ones) on the app's node; checks queued or running for that " +
    'commit already are skipped (409 when none is left). Works whether or not `checks.enabled` ' +
    'is set. Each run is reported to GitHub as the commit status `launchway/<name>`. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams, body: jsonBody(CreateCheckRunsInput) },
  responses: {
    201: jsonResponse(CheckRunList, 'The queued runs'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const getCheckRun = createRoute({
  method: 'get',
  path: '/checks/{id}',
  operationId: 'getCheckRun',
  tags: TAGS,
  summary: 'Get a check run',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: CheckRunParams },
  responses: {
    200: jsonResponse(CheckRun, 'The check run'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const getCheckRunLogs = createRoute({
  method: 'get',
  path: '/checks/{id}/logs',
  operationId: 'getCheckRunLogs',
  tags: TAGS,
  summary: 'Stream the output of a check run (SSE)',
  description:
    'Server-Sent Events: `log` (LogLine, SSE id = seq) for the stored history after `after`, then, ' +
    'with `follow=true` and while the run is queued or running, live `log` and `status` events. ' +
    'The stream ends with `end` ({ status }) once the run finished. Lines are kept for 30 days.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: CheckRunParams, query: CheckLogsQuery },
  responses: {
    200: {
      description: 'Event stream (see CheckStreamEvent)',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...problemResponses(400, 401, 403, 404),
  },
});

const cancelCheckRun = createRoute({
  method: 'post',
  path: '/checks/{id}/cancel',
  operationId: 'cancelCheckRun',
  tags: TAGS,
  summary: 'Cancel a queued or running check run',
  description:
    'A queued run is cancelled at once; a running one is stopped by its node, which reports ' +
    '`cancelled` (the answer may still show it running). Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: CheckRunParams },
  responses: {
    200: jsonResponse(CheckRun, 'The check run after the request'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const rerunCheckRun = createRoute({
  method: 'post',
  path: '/checks/{id}/rerun',
  operationId: 'rerunCheckRun',
  tags: TAGS,
  summary: 'Run a finished check run again',
  description:
    "Queues a new run of the same check for the same commit with the check's current " +
    'configuration. 409 while the check is queued or running for that commit, or when it is no ' +
    'longer configured. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: CheckRunParams },
  responses: {
    201: jsonResponse(CheckRun, 'The new run'),
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

export function registerChecksRoutes(api: Api, deps: Deps): void {
  const service = createChecksService(deps);

  api.openapi(listCheckRuns, async (c) =>
    c.json(await service.list(c.req.valid('param').id, c.req.valid('query')), 200),
  );

  api.openapi(createCheckRuns, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await service.createManual(id, c.req.valid('json'), requestActor(c)), 201);
  });

  api.openapi(getCheckRun, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(getCheckRunLogs, async (c) => {
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    await service.get(id);
    const logger = c.get('logger');
    return sseResponse(c, (signal) => service.logStream(id, query, signal), {
      signal: deps.lifecycle.signal,
      onError: (error) => logger.error({ err: error }, 'check log stream failed'),
    });
  });

  api.openapi(cancelCheckRun, async (c) =>
    c.json(await service.cancel(c.req.valid('param').id, requestActor(c)), 200),
  );

  api.openapi(rerunCheckRun, async (c) =>
    c.json(await service.rerun(c.req.valid('param').id, requestActor(c)), 201),
  );
}
