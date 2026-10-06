import {
  type AcceptInvitationBody,
  type CreatedInvitation,
  type CreateInvitationInput,
  INVITATION_TOKEN_PREFIX,
  type Invitation,
  type InvitationId,
  type InvitationPage,
  type InvitationPreview,
  type InvitationStatus,
  type PaginationQuery,
} from '@slipway/contracts';
import { desc, eq, getTableColumns } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { effectiveRole, getActorPrincipal, type RequestActor } from '../../lib/auth-context.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { invalidField, notFound, ProblemError } from '../../lib/problem.js';
import { afterCursor, createdAtKey, toPage } from '../audit/keyset.js';
import { recordAudit } from '../audit/service.js';
import { hashPassword } from '../auth/password.js';
import { actingAs, type SignedIn, sessionMe, startSession } from '../auth/service.js';
import { assertCanInvite } from '../users/rules.js';
import { users } from '../users/schema.js';
import { insertUser, loadUser } from '../users/service.js';
import { invitations } from './schema.js';

type InvitationRow = typeof invitations.$inferSelect;
type InviterColumns = { inviterName: string | null; inviterEmail: string | null };

function statusOf(row: InvitationRow, now = new Date()): InvitationStatus {
  if (row.acceptedAt) return 'accepted';
  return row.expiresAt <= now ? 'expired' : 'pending';
}

function toInvitation(row: InvitationRow & InviterColumns): Invitation {
  return {
    id: row.id,
    email: row.email,
    // The database CHECK rules out 'owner'.
    role: row.role === 'owner' ? 'admin' : row.role,
    status: statusOf(row),
    invitedBy:
      row.invitedById && row.inviterName !== null && row.inviterEmail !== null
        ? { id: row.invitedById, name: row.inviterName, email: row.inviterEmail }
        : null,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const invitationSelection = {
  ...getTableColumns(invitations),
  inviterName: users.name,
  inviterEmail: users.email,
};

/** Accept link shown to the inviter. The token sits in the fragment, so it never reaches logs. */
export function invitationUrl(origin: string, token: string): string {
  return `${origin}/invite#${token}`;
}

function unusable(row: InvitationRow): ProblemError | null {
  const status = statusOf(row);
  if (status === 'accepted')
    return new ProblemError('gone', { detail: 'The invitation was already used' });
  if (status === 'expired')
    return new ProblemError('gone', { detail: 'The invitation has expired' });
  return null;
}

export interface InvitationsService {
  /** `platformOrigin` is resolved after authorization, for the accept link. */
  create(
    input: CreateInvitationInput,
    actor: RequestActor,
    platformOrigin: () => Promise<string>,
  ): Promise<CreatedInvitation>;
  list(query: PaginationQuery): Promise<InvitationPage>;
  revoke(id: InvitationId, actor: RequestActor): Promise<void>;
  preview(token: string): Promise<InvitationPreview>;
  accept(token: string, input: AcceptInvitationBody, actor: RequestActor): Promise<SignedIn>;
}

export function createInvitationsService(deps: Pick<Deps, 'db' | 'events'>): InvitationsService {
  async function findByToken(token: string): Promise<InvitationRow> {
    const [row] = await deps.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(token)));
    if (!row) throw notFound('Invitation not found');
    return row;
  }

  return {
    async create(input, actor, platformOrigin) {
      const principal = getActorPrincipal(actor);
      assertCanInvite(effectiveRole(principal), input.role);
      const origin = await platformOrigin();
      const token = generateToken(INVITATION_TOKEN_PREFIX);
      const row = await deps.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(invitations)
          .values({
            email: input.email ?? null,
            role: input.role,
            tokenHash: hashToken(token),
            invitedById: principal.user.id,
            expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000),
          })
          .returning();
        if (!inserted) throw new Error('invitation insert returned no row');
        await recordAudit(tx, actor, {
          action: 'invitation.create',
          target: { type: 'invitation', id: inserted.id },
          summary: {
            role: inserted.role,
            email: inserted.email,
            expiresAt: inserted.expiresAt.toISOString(),
          },
        });
        return inserted;
      });
      deps.events.publish({ topic: 'invitations', action: 'created', resourceId: row.id });
      return {
        invitation: toInvitation({
          ...row,
          inviterName: principal.user.name,
          inviterEmail: principal.user.email,
        }),
        token,
        url: invitationUrl(origin, token),
      };
    },

    async list({ limit, cursor }) {
      const rows = await deps.db
        .select({ ...invitationSelection, createdAtKey: createdAtKey(invitations.createdAt) })
        .from(invitations)
        .leftJoin(users, eq(users.id, invitations.invitedById))
        .where(afterCursor(cursor, invitations.createdAt, invitations.id, 'desc'))
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(limit + 1);
      return toPage(rows, limit, toInvitation);
    },

    async revoke(id, actor) {
      const principal = getActorPrincipal(actor);
      await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.id, id))
          .for('update');
        if (!row) throw notFound('Invitation not found');
        if (row.role !== 'owner') assertCanInvite(effectiveRole(principal), row.role);
        await tx.delete(invitations).where(eq(invitations.id, id));
        await recordAudit(tx, actor, {
          action: 'invitation.delete',
          target: { type: 'invitation', id },
          summary: { role: row.role, email: row.email, status: statusOf(row) },
        });
      });
      deps.events.publish({ topic: 'invitations', action: 'deleted', resourceId: id });
    },

    async preview(token) {
      const row = await findByToken(token);
      const problem = unusable(row);
      if (problem) throw problem;
      return {
        email: row.email,
        role: row.role === 'owner' ? 'admin' : row.role,
        expiresAt: row.expiresAt.toISOString(),
      };
    },

    async accept(token, input, actor) {
      const passwordHash = input.password === undefined ? null : await hashPassword(input.password);
      const result = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.tokenHash, hashToken(token)))
          .for('update');
        if (!row) throw notFound('Invitation not found');
        const problem = unusable(row);
        if (problem) throw problem;
        if (row.role === 'owner') throw new Error('invitation with owner role');

        const email = row.email ?? input.email;
        if (!email) throw invalidField('body.email', 'This invitation needs an e-mail address');
        if (row.email && input.email && input.email !== row.email) {
          throw invalidField('body.email', 'The invitation is addressed to another e-mail address');
        }

        const user = await insertUser(tx, {
          email,
          name: input.name,
          role: row.role,
          passwordHash,
        });
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date(), acceptedById: user.id })
          .where(eq(invitations.id, row.id));
        const as = actingAs(actor, user);
        await recordAudit(tx, as, {
          action: 'invitation.accept',
          target: { type: 'invitation', id: row.id },
          summary: { userId: user.id, email: user.email, role: user.role },
        });
        const session = await startSession(tx, user.id, as);
        const loaded = await loadUser(tx, user.id);
        if (!loaded) throw new Error('accepted user vanished');
        return { ...session, invitationId: row.id, user: loaded };
      });
      deps.events.publish({ topic: 'users', action: 'created', resourceId: result.user.id });
      deps.events.publish({
        topic: 'invitations',
        action: 'updated',
        resourceId: result.invitationId,
      });
      return { token: result.token, me: sessionMe(result.user, result.sessionId) };
    },
  };
}
