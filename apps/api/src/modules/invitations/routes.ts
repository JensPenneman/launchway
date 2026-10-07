import { createRoute, z } from '@hono/zod-openapi';
import {
  AcceptInvitationBody,
  CreatedInvitation,
  CreateInvitationInput,
  INVITATION_TOKEN_PATTERN,
  InvitationId,
  InvitationPage,
  InvitationPreview,
  Me,
  PaginationQuery,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { createPlatformOriginResolver } from '../../lib/csrf.js';
import {
  AUTHENTICATED,
  jsonBody,
  jsonResponse,
  PUBLIC,
  problemResponses,
} from '../../lib/openapi.js';
import { writeSessionCookie } from '../auth/session-cookie.js';
import { createInvitationsService } from './service.js';

const TokenParams = z.object({
  token: z
    .string()
    .regex(INVITATION_TOKEN_PATTERN, 'Must be an invitation token (lwyi_...)')
    .openapi({ param: { name: 'token', in: 'path' }, example: `lwyi_${'0'.repeat(43)}` }),
});

const createInvitation = createRoute({
  method: 'post',
  path: '/invitations',
  operationId: 'createInvitation',
  tags: ['Invitations'],
  summary: 'Invite someone',
  description:
    'Returns the single-use token and accept link once. Admins invite members and viewers; only ' +
    'the owner invites admins. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { body: jsonBody(CreateInvitationInput) },
  responses: {
    201: jsonResponse(CreatedInvitation, 'The invitation with its link'),
    ...problemResponses(400, 401, 403),
  },
});

const listInvitations = createRoute({
  method: 'get',
  path: '/invitations',
  operationId: 'listInvitations',
  tags: ['Invitations'],
  summary: 'List invitations',
  description: 'Newest first, cursor-paginated. Requires the admin role.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { query: PaginationQuery },
  responses: {
    200: jsonResponse(InvitationPage, 'A page of invitations'),
    ...problemResponses(400, 401, 403),
  },
});

const deleteInvitation = createRoute({
  method: 'delete',
  path: '/invitations/{id}',
  operationId: 'deleteInvitation',
  tags: ['Invitations'],
  summary: 'Revoke an invitation',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: z.object({ id: InvitationId }) },
  responses: { 204: { description: 'Revoked' }, ...problemResponses(400, 401, 403, 404) },
});

const previewInvitation = createRoute({
  method: 'get',
  path: '/invitations/{token}',
  operationId: 'previewInvitation',
  tags: ['Invitations'],
  summary: 'What an invitation offers (for the accept page)',
  description: '404 for unknown tokens, 410 for used or expired invitations. Rate limited.',
  security: PUBLIC,
  request: { params: TokenParams },
  responses: {
    200: jsonResponse(InvitationPreview, 'The invitation'),
    ...problemResponses(400, 404, 410, 429),
  },
});

const acceptInvitation = createRoute({
  method: 'post',
  path: '/invitations/{token}/accept',
  operationId: 'acceptInvitation',
  tags: ['Invitations'],
  summary: 'Accept an invitation and create your account',
  description:
    'Creates the account with the invited role and signs it in (sets the session cookie). ' +
    'Without a password, register a passkey right after. Rate limited. Audited.',
  security: PUBLIC,
  request: { params: TokenParams, body: jsonBody(AcceptInvitationBody) },
  responses: {
    201: jsonResponse(Me, 'Account created and signed in'),
    ...problemResponses(400, 403, 404, 409, 410, 429),
  },
});

export function registerInvitationsRoutes(api: Api, deps: Deps): void {
  const service = createInvitationsService(deps);
  const origins = createPlatformOriginResolver(deps);

  api.openapi(createInvitation, async (c) => {
    const created = await service.create(c.req.valid('json'), requestActor(c), () =>
      origins.forRequest(c),
    );
    return c.json(created, 201);
  });

  api.openapi(listInvitations, async (c) => c.json(await service.list(c.req.valid('query')), 200));

  api.openapi(deleteInvitation, async (c) => {
    await service.revoke(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(previewInvitation, async (c) =>
    c.json(await service.preview(c.req.valid('param').token), 200),
  );

  api.openapi(acceptInvitation, async (c) => {
    const { token, me } = await service.accept(
      c.req.valid('param').token,
      c.req.valid('json'),
      requestActor(c),
    );
    writeSessionCookie(c, token);
    return c.json(me, 201);
  });
}
