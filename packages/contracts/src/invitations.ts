import { DisplayName, Email, Password, Timestamp } from './common.js';
import { InvitationId } from './ids.js';
import { page } from './pagination.js';
import { AssignableRole, UserSummary } from './users.js';
import { z } from './zod.js';

/** Invitation link tokens are `lwyi_` + 43 base62 characters; stored as SHA-256 hashes. */
export const INVITATION_TOKEN_PREFIX = 'lwyi_';
export const INVITATION_TOKEN_PATTERN = /^lwyi_[0-9A-Za-z]{43}$/;
export const DEFAULT_INVITATION_TTL_HOURS = 72;
export const MAX_INVITATION_TTL_HOURS = 30 * 24;

export const INVITATION_STATUSES = ['pending', 'accepted', 'expired'] as const;
export const InvitationStatus = z.enum(INVITATION_STATUSES).openapi('InvitationStatus');
export type InvitationStatus = z.infer<typeof InvitationStatus>;

export const Invitation = z
  .object({
    id: InvitationId,
    email: Email.nullable().openapi({
      description: 'Optional addressee; null = anyone with the link',
    }),
    role: AssignableRole,
    status: InvitationStatus,
    invitedBy: UserSummary.nullable(),
    expiresAt: Timestamp,
    acceptedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('Invitation');
export type Invitation = z.infer<typeof Invitation>;

export const InvitationPage = page(Invitation).openapi('InvitationPage');
export type InvitationPage = z.infer<typeof InvitationPage>;

export const CreateInvitationInput = z
  .strictObject({
    role: AssignableRole,
    email: Email.optional(),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(MAX_INVITATION_TTL_HOURS)
      .default(DEFAULT_INVITATION_TTL_HOURS),
  })
  .openapi('CreateInvitationInput');
export type CreateInvitationInput = z.infer<typeof CreateInvitationInput>;

export const CreatedInvitation = z
  .object({
    invitation: Invitation,
    token: z.string().regex(INVITATION_TOKEN_PATTERN).openapi({ description: 'Returned once' }),
    url: z.url().openapi({ description: 'Link to share with the invitee' }),
  })
  .openapi('CreatedInvitation');
export type CreatedInvitation = z.infer<typeof CreatedInvitation>;

/** What the accept page shows before the invitee signs up. */
export const InvitationPreview = z
  .object({ email: Email.nullable(), role: AssignableRole, expiresAt: Timestamp })
  .openapi('InvitationPreview');
export type InvitationPreview = z.infer<typeof InvitationPreview>;

export const AcceptInvitationInput = z
  .strictObject({
    token: z.string().regex(INVITATION_TOKEN_PATTERN),
    name: DisplayName,
    email: Email.optional().openapi({ description: 'Required when the invitation has no e-mail' }),
    password: Password.optional().openapi({
      description: 'Optional; without a password the invitee registers a passkey right after',
    }),
  })
  .openapi('AcceptInvitationInput');
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationInput>;

/** Body of `POST /invitations/{token}/accept` (the token travels in the path). */
export const AcceptInvitationBody = z
  .strictObject({
    name: DisplayName,
    email: Email.optional().openapi({ description: 'Required when the invitation has no e-mail' }),
    password: Password.optional().openapi({
      description: 'Optional; without a password the invitee registers a passkey right after',
    }),
  })
  .openapi('AcceptInvitationBody');
export type AcceptInvitationBody = z.infer<typeof AcceptInvitationBody>;
