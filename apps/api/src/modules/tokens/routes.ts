import { createRoute, z } from '@hono/zod-openapi';
import { ApiTokenId, ApiTokenList, CreateApiTokenInput, CreatedApiToken } from '@slipway/contracts';
import type { Api, Deps } from '../../deps.js';
import { getPrincipal, requestActor, requireRole } from '../../lib/auth-context.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createTokensService } from './service.js';

const createToken = createRoute({
  method: 'post',
  path: '/tokens',
  operationId: 'createApiToken',
  tags: ['Tokens'],
  summary: 'Create an API token',
  description:
    'Returns the plaintext token once; only its SHA-256 hash is stored. Scopes are capped by your ' +
    'role (viewer: read; member: read, write; admin/owner: all). Requires a signed-in session. ' +
    'Rate limited. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { body: jsonBody(CreateApiTokenInput) },
  responses: {
    201: jsonResponse(CreatedApiToken, 'The new token and its plaintext secret'),
    ...problemResponses(400, 401, 403, 429),
  },
});

const listTokens = createRoute({
  method: 'get',
  path: '/tokens',
  operationId: 'listApiTokens',
  tags: ['Tokens'],
  summary: 'List your API tokens',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(ApiTokenList, 'Your tokens, newest first'),
    ...problemResponses(401, 403),
  },
});

const revokeToken = createRoute({
  method: 'delete',
  path: '/tokens/{id}',
  operationId: 'revokeApiToken',
  tags: ['Tokens'],
  summary: 'Revoke one of your API tokens',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: z.object({ id: ApiTokenId }) },
  responses: {
    204: { description: 'Revoked' },
    ...problemResponses(400, 401, 403, 404),
  },
});

export function registerTokensRoutes(api: Api, deps: Deps): void {
  const service = createTokensService(deps);

  api.openapi(createToken, async (c) =>
    c.json(await service.create(c.req.valid('json'), requestActor(c)), 201),
  );

  api.openapi(listTokens, async (c) => c.json(await service.list(getPrincipal(c).user.id), 200));

  api.openapi(revokeToken, async (c) => {
    await service.revoke(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });
}
