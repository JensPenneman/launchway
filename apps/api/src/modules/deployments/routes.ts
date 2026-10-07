import { createRoute, z } from '@hono/zod-openapi';
import {
  AppId,
  CreateDeploymentInput,
  Deployment,
  DeploymentId,
  DeploymentListQuery,
  DeploymentLogsQuery,
  DeploymentPage,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { sseResponse } from '../../lib/sse.js';
import { createDeploymentsService } from './service.js';

const AppParams = z.object({ id: AppId });
const DeploymentParams = z.object({ id: DeploymentId });
const TAGS = ['Deployments'];

const createDeployment = createRoute({
  method: 'post',
  path: '/apps/{id}/deployments',
  operationId: 'createDeployment',
  tags: TAGS,
  summary: 'Deploy a ref of an app',
  description:
    'Resolves the ref (release tag, branch or commit) to a commit SHA, queues the deployment and ' +
    'sends it to the node when no other deployment of the app is in progress. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams, body: jsonBody(CreateDeploymentInput) },
  responses: {
    201: jsonResponse(Deployment, 'The queued deployment'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const listDeployments = createRoute({
  method: 'get',
  path: '/apps/{id}/deployments',
  operationId: 'listDeployments',
  tags: TAGS,
  summary: 'List the deployments of an app (newest first)',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams, query: DeploymentListQuery },
  responses: {
    200: jsonResponse(DeploymentPage, 'A page of deployments'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const getDeployment = createRoute({
  method: 'get',
  path: '/deployments/{id}',
  operationId: 'getDeployment',
  tags: TAGS,
  summary: 'Get a deployment',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: DeploymentParams },
  responses: {
    200: jsonResponse(Deployment, 'The deployment'),
    ...problemResponses(401, 403, 404),
  },
});

const getDeploymentLogs = createRoute({
  method: 'get',
  path: '/deployments/{id}/logs',
  operationId: 'getDeploymentLogs',
  tags: TAGS,
  summary: 'Stream the build and run output of a deployment (SSE)',
  description:
    'Server-Sent Events: `log` (LogLine, SSE id = seq) for the stored history after `after`, then, ' +
    'with `follow=true` and while the deployment is in progress, live `log` and `status` events. ' +
    'The stream ends with `end` ({ status }).',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: DeploymentParams, query: DeploymentLogsQuery },
  responses: {
    200: {
      description: 'Event stream (see DeploymentStreamEvent)',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...problemResponses(400, 401, 403, 404),
  },
});

const cancelDeployment = createRoute({
  method: 'post',
  path: '/deployments/{id}/cancel',
  operationId: 'cancelDeployment',
  tags: TAGS,
  summary: 'Cancel a queued or in-progress deployment',
  description:
    'A deployment not yet sent to the node is cancelled at once; otherwise the agent is asked to ' +
    'stop it and reports `cancelled` when done. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: DeploymentParams },
  responses: {
    200: jsonResponse(Deployment, 'The deployment after the request'),
    ...problemResponses(401, 403, 404, 409),
  },
});

export function registerDeploymentsRoutes(api: Api, deps: Deps): void {
  const service = createDeploymentsService(deps);

  api.openapi(createDeployment, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await service.create(id, c.req.valid('json'), requestActor(c)), 201);
  });

  api.openapi(listDeployments, async (c) =>
    c.json(await service.list(c.req.valid('param').id, c.req.valid('query')), 200),
  );

  api.openapi(getDeployment, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(getDeploymentLogs, async (c) => {
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    await service.get(id);
    const logger = c.get('logger');
    return sseResponse(c, (signal) => service.logStream(id, query, signal), {
      signal: deps.lifecycle.signal,
      onError: (error) => logger.error({ err: error }, 'deployment log stream failed'),
    });
  });

  api.openapi(cancelDeployment, async (c) =>
    c.json(await service.cancel(c.req.valid('param').id, requestActor(c)), 200),
  );
}
