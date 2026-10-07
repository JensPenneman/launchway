import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateRouteInput,
  Route,
  RouteId,
  RouteListQuery,
  RoutePage,
  UpdateRouteInput,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createRoutesService } from './service.js';

const RouteParams = z.object({ id: RouteId });
const TAGS = ['Routes'];

const listRoutes = createRoute({
  method: 'get',
  path: '/routes',
  operationId: 'listRoutes',
  tags: TAGS,
  summary: 'List routes',
  description: 'Cursor-paginated; filter by `appId` or `domainId`.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { query: RouteListQuery },
  responses: {
    200: jsonResponse(RoutePage, 'A page of routes'),
    ...problemResponses(400, 401, 403),
  },
});

const createRouteOp = createRoute({
  method: 'post',
  path: '/routes',
  operationId: 'createRoute',
  tags: TAGS,
  summary: 'Create a route',
  description:
    'One route per domain. App targets need a routable service whose network alias (`<slug>-<service>`) no other app uses; redirects need an https URL. Audited; the edge configuration is regenerated.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { body: jsonBody(CreateRouteInput) },
  responses: {
    201: jsonResponse(Route, 'The new route'),
    ...problemResponses(400, 401, 403, 409),
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/routes/{id}',
  operationId: 'getRoute',
  tags: TAGS,
  summary: 'Get a route',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: RouteParams },
  responses: { 200: jsonResponse(Route, 'The route'), ...problemResponses(400, 401, 403, 404) },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/routes/{id}',
  operationId: 'updateRoute',
  tags: TAGS,
  summary: 'Update a route',
  description: 'Change the target or options; the domain is fixed. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: RouteParams, body: jsonBody(UpdateRouteInput) },
  responses: {
    200: jsonResponse(Route, 'The updated route'),
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/routes/{id}',
  operationId: 'deleteRoute',
  tags: TAGS,
  summary: 'Delete a route',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: RouteParams },
  responses: { 204: { description: 'Deleted' }, ...problemResponses(400, 401, 403, 404) },
});

export function registerRoutesRoutes(api: Api, deps: Deps): void {
  const service = createRoutesService(deps);

  api.openapi(listRoutes, async (c) => c.json(await service.list(c.req.valid('query')), 200));

  api.openapi(createRouteOp, async (c) =>
    c.json(await service.create(c.req.valid('json'), requestActor(c)), 201),
  );

  api.openapi(getRoute, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(updateRoute, async (c) =>
    c.json(
      await service.update(c.req.valid('param').id, c.req.valid('json'), requestActor(c)),
      200,
    ),
  );

  api.openapi(deleteRoute, async (c) => {
    await service.remove(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });
}
