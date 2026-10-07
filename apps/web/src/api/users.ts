import {
  type AcceptInvitationInput,
  ApiTokenList,
  AuditEventPage,
  type CreateApiTokenInput,
  CreatedApiToken,
  CreatedInvitation,
  type CreateInvitationInput,
  InvitationPage,
  InvitationPreview,
  type UpdateUserInput,
  UserPage,
  type z,
} from '@launchway/contracts';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

// --- Users -------------------------------------------------------------------------------------

export const usersQuery = queryOptions({
  queryKey: [...keys.users, 'list'],
  queryFn: ({ signal }) => request('/users', { query: { limit: 100 }, schema: UserPage, signal }),
});

export function updateUser(id: string, input: UpdateUserInput) {
  return request(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
}

export function deleteUser(id: string) {
  return request(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Invitations -------------------------------------------------------------------------------

export const invitationsQuery = queryOptions({
  queryKey: [...keys.invitations, 'list'],
  queryFn: ({ signal }) =>
    request('/invitations', { query: { limit: 100 }, schema: InvitationPage, signal }),
});

export function createInvitation(input: z.input<typeof CreateInvitationInput>) {
  return request('/invitations', { method: 'POST', body: input, schema: CreatedInvitation });
}

export function revokeInvitation(id: string) {
  return request(`/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function invitationPreviewQuery(token: string) {
  return queryOptions({
    queryKey: [...keys.invitations, 'preview', token],
    queryFn: ({ signal }) =>
      request(`/invitations/${encodeURIComponent(token)}`, {
        schema: InvitationPreview,
        signal,
        onUnauthorized: 'throw',
      }),
    retry: false,
  });
}

/** The token travels in the path; the body carries the new account's details. */
export function acceptInvitation({ token, ...body }: AcceptInvitationInput) {
  return request(`/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body,
    onUnauthorized: 'throw',
  });
}

// --- API tokens --------------------------------------------------------------------------------

export const tokensQuery = queryOptions({
  queryKey: [...keys.tokens, 'list'],
  queryFn: ({ signal }) => request('/tokens', { schema: ApiTokenList, signal }),
});

export function createToken(input: z.input<typeof CreateApiTokenInput>) {
  return request('/tokens', { method: 'POST', body: input, schema: CreatedApiToken });
}

export function revokeToken(id: string) {
  return request(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Audit log ---------------------------------------------------------------------------------

export interface AuditFilters {
  action?: string | undefined;
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
}

export function auditQuery(filters: AuditFilters) {
  return infiniteQueryOptions({
    queryKey: [...keys.audit, filters],
    queryFn: ({ signal, pageParam }) =>
      request('/audit', {
        query: { ...filters, limit: 50, cursor: pageParam },
        schema: AuditEventPage,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
