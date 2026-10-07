import { createRoute, z } from '@hono/zod-openapi';
import {
  AppId,
  CreatePreviewInput,
  Preview,
  PreviewId,
  PreviewListQuery,
  PreviewPage,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createPreviewsService } from './service.js';

const AppParams = z.object({ id: AppId });
const PreviewParams = z.object({ id: PreviewId });
const TAGS = ['Previews'];

const createPreview = createRoute({
  method: 'post',
  path: '/apps/{id}/previews',
  operationId: 'createPreview',
  tags: TAGS,
  summary: 'Open the preview of a pull request',
  description:
    'Fetches the pull request from GitHub, creates (or updates) its preview with a domain under ' +
    'the preview base domain and a route like the app’s first route, and deploys the head commit. ' +
    'The pull request must be open and come from a branch of the same repository. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AppParams, body: jsonBody(CreatePreviewInput) },
  responses: {
    201: jsonResponse(Preview, 'The preview with its queued deployment'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const listAppPreviews = createRoute({
  method: 'get',
  path: '/apps/{id}/previews',
  operationId: 'listAppPreviews',
  tags: TAGS,
  summary: 'List the previews of an app (newest first)',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AppParams, query: PreviewListQuery },
  responses: {
    200: jsonResponse(PreviewPage, 'A page of previews'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const listPreviews = createRoute({
  method: 'get',
  path: '/previews',
  operationId: 'listPreviews',
  tags: TAGS,
  summary: 'List the previews of all apps (newest first)',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { query: PreviewListQuery },
  responses: {
    200: jsonResponse(PreviewPage, 'A page of previews'),
    ...problemResponses(400, 401, 403),
  },
});

const getPreview = createRoute({
  method: 'get',
  path: '/previews/{id}',
  operationId: 'getPreview',
  tags: TAGS,
  summary: 'Get a preview',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: PreviewParams },
  responses: {
    200: jsonResponse(Preview, 'The preview'),
    ...problemResponses(401, 403, 404),
  },
});

const redeployPreview = createRoute({
  method: 'post',
  path: '/previews/{id}/redeploy',
  operationId: 'redeployPreview',
  tags: TAGS,
  summary: 'Deploy the head commit of a preview again',
  description:
    'Re-creates a missing domain or route of the preview and queues a deployment of its head ' +
    'commit. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: PreviewParams },
  responses: {
    200: jsonResponse(Preview, 'The preview with its queued deployment'),
    ...problemResponses(401, 403, 404, 409, 502),
  },
});

const deletePreview = createRoute({
  method: 'delete',
  path: '/previews/{id}',
  operationId: 'closePreview',
  tags: TAGS,
  summary: 'Close a preview',
  description:
    'Removes the route, the domain (and its DNS record) and the Compose project with its volumes. ' +
    'The preview stays `closing` while its node is offline and is kept as `closed` for seven days. ' +
    'Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: PreviewParams },
  responses: {
    200: jsonResponse(Preview, 'The preview after the request (closing or closed)'),
    ...problemResponses(401, 403, 404, 502),
  },
});

export function registerPreviewsRoutes(api: Api, deps: Deps): void {
  const service = createPreviewsService(deps);

  api.openapi(createPreview, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await service.create(id, c.req.valid('json'), requestActor(c)), 201);
  });

  api.openapi(listAppPreviews, async (c) =>
    c.json(await service.list({ ...c.req.valid('query'), appId: c.req.valid('param').id }), 200),
  );

  api.openapi(listPreviews, async (c) => c.json(await service.list(c.req.valid('query')), 200));

  api.openapi(getPreview, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(redeployPreview, async (c) =>
    c.json(await service.redeploy(c.req.valid('param').id, requestActor(c)), 200),
  );

  api.openapi(deletePreview, async (c) =>
    c.json(await service.close(c.req.valid('param').id, requestActor(c)), 200),
  );
}
