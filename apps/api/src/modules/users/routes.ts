import { createRoute, z } from '@hono/zod-openapi';
import { PaginationQuery, UpdateUserInput, User, UserId, UserPage } from '@slipway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createUsersService } from './service.js';

const UserParams = z.object({ id: UserId });

const listUsers = createRoute({
  method: 'get',
  path: '/users',
  operationId: 'listUsers',
  tags: ['Users'],
  summary: 'List users',
  description: 'Oldest first, cursor-paginated. Requires the admin role.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { query: PaginationQuery },
  responses: {
    200: jsonResponse(UserPage, 'A page of users'),
    ...problemResponses(400, 401, 403),
  },
});

const getUser = createRoute({
  method: 'get',
  path: '/users/{id}',
  operationId: 'getUser',
  tags: ['Users'],
  summary: 'Get a user',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: UserParams },
  responses: {
    200: jsonResponse(User, 'The user'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const updateUser = createRoute({
  method: 'patch',
  path: '/users/{id}',
  operationId: 'updateUser',
  tags: ['Users'],
  summary: 'Rename a user or change their role',
  description:
    'Admins manage members and viewers; only the owner manages admins and grants the admin role. ' +
    'The owner cannot be demoted. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: UserParams, body: jsonBody(UpdateUserInput) },
  responses: {
    200: jsonResponse(User, 'The updated user'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const deleteUser = createRoute({
  method: 'delete',
  path: '/users/{id}',
  operationId: 'deleteUser',
  tags: ['Users'],
  summary: 'Delete a user',
  description:
    'Removes the account with its sessions, passkeys and API tokens. The owner cannot be deleted; ' +
    'only the owner deletes admins. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: UserParams },
  responses: {
    204: { description: 'Deleted' },
    ...problemResponses(400, 401, 403, 404),
  },
});

export function registerUsersRoutes(api: Api, deps: Deps): void {
  const service = createUsersService(deps);

  api.openapi(listUsers, async (c) => c.json(await service.list(c.req.valid('query')), 200));

  api.openapi(getUser, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(updateUser, async (c) => {
    const user = await service.update(
      c.req.valid('param').id,
      c.req.valid('json'),
      requestActor(c),
    );
    return c.json(user, 200);
  });

  api.openapi(deleteUser, async (c) => {
    await service.remove(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });
}
