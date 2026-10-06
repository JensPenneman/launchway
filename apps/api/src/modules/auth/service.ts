import {
  type ChangePasswordInput,
  type LoginInput,
  type Me,
  SESSION_TTL_SECONDS,
  type Session,
  type SessionId,
  type SessionList,
  type SetupInput,
  type SetupStatus,
  type UpdateMeInput,
  type User,
  type UserId,
} from '@slipway/contracts';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import type { Principal, RequestActor } from '../../lib/auth-context.js';
import { hashToken } from '../../lib/crypto.js';
import { conflict, invalidField, notFound, unauthorized } from '../../lib/problem.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { users } from '../users/schema.js';
import { insertUser, loadUser } from '../users/service.js';
import { hashPassword, verifyPassword } from './password.js';
import { sessions } from './schema.js';
import { generateSessionToken } from './session-cookie.js';

type SessionPrincipal = Extract<Principal, { kind: 'session' }>;

/** A freshly created session: the cookie value (returned once) and the API view of the caller. */
export interface SignedIn {
  readonly token: string;
  readonly me: Me;
}

/** Audit actor for a user who is signing in (the request itself is still anonymous). */
export function actingAs(actor: RequestActor, user: { id: UserId; email: string }): RequestActor {
  return { ...actor, actor: { type: 'user', id: user.id, label: user.email } };
}

/**
 * Creates a session for `userId` (new random id: no session fixation) and records the sign-in.
 * Call inside the transaction of the sign-in; returns the cookie value.
 */
export async function startSession(
  tx: Executor,
  userId: UserId,
  actor: RequestActor,
): Promise<{ token: string; sessionId: SessionId }> {
  const token = generateSessionToken();
  const now = new Date();
  const [session] = await tx
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
      lastUsedAt: now,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error('session insert returned no row');
  await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return { token, sessionId: session.id };
}

export function sessionMe(user: User, sessionId: SessionId): Me {
  return { user, authMethod: 'session', sessionId, tokenId: null, scopes: null };
}

async function requireUser(db: Executor, id: UserId): Promise<User> {
  const user = await loadUser(db, id);
  if (!user) throw unauthorized();
  return user;
}

export interface AuthService {
  setupStatus(): Promise<SetupStatus>;
  setup(input: SetupInput, actor: RequestActor): Promise<SignedIn>;
  /** `previousToken`: the session cookie the request carried; that session is ended. */
  login(input: LoginInput, actor: RequestActor, previousToken: string | null): Promise<SignedIn>;
  logout(principal: SessionPrincipal, actor: RequestActor): Promise<void>;
  me(principal: Principal): Promise<Me>;
  updateMe(principal: SessionPrincipal, input: UpdateMeInput, actor: RequestActor): Promise<Me>;
  changePassword(
    principal: SessionPrincipal,
    input: ChangePasswordInput,
    actor: RequestActor,
  ): Promise<void>;
  listSessions(principal: Principal): Promise<SessionList>;
  revokeSession(principal: SessionPrincipal, id: SessionId, actor: RequestActor): Promise<void>;
}

export function createAuthService(deps: Pick<Deps, 'db' | 'events' | 'logger'>): AuthService {
  async function me(principal: Principal): Promise<Me> {
    const user = await requireUser(deps.db, principal.user.id);
    return principal.kind === 'session'
      ? sessionMe(user, principal.sessionId)
      : {
          user,
          authMethod: 'token',
          sessionId: null,
          tokenId: principal.tokenId,
          scopes: [...principal.scopes],
        };
  }

  return {
    async setupStatus() {
      const [row] = await deps.db.select({ id: users.id }).from(users).limit(1);
      return { setupRequired: row === undefined };
    },

    async setup(input, actor) {
      const passwordHash = await hashPassword(input.password);
      const result = await deps.db.transaction(async (tx) => {
        // Serializes concurrent setup attempts; the single-owner index is the final guard.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('slipway:setup'))`);
        const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
        if (existing) throw conflict('Setup is already complete');
        const owner = await insertUser(tx, {
          email: input.email,
          name: input.name,
          role: 'owner',
          passwordHash,
        });
        const as = actingAs(actor, owner);
        await recordAudit(tx, as, {
          action: 'setup.complete',
          target: { type: 'user', id: owner.id },
          summary: { email: owner.email, name: owner.name },
        });
        const session = await startSession(tx, owner.id, as);
        return { ...session, user: await requireUser(tx, owner.id) };
      });
      deps.events.publish({ topic: 'users', action: 'created', resourceId: result.user.id });
      return { token: result.token, me: sessionMe(result.user, result.sessionId) };
    },

    async login(input, actor, previousToken) {
      const [user] = await deps.db
        .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(sql`lower(${users.email})`, input.email.toLowerCase()));
      const valid = await verifyPassword(user?.passwordHash ?? null, input.password);
      if (!user || !valid) {
        await recordAudit(deps.db, actor, {
          action: 'auth.login-failed',
          target: { type: 'user', id: user?.id ?? null },
          summary: { method: 'password', email: input.email },
        });
        throw unauthorized('Invalid e-mail address or password');
      }

      const result = await deps.db.transaction(async (tx) => {
        if (previousToken) {
          await tx.delete(sessions).where(eq(sessions.tokenHash, hashToken(previousToken)));
        }
        const as = actingAs(actor, user);
        const session = await startSession(tx, user.id, as);
        await recordAudit(tx, as, {
          action: 'auth.login',
          target: { type: 'user', id: user.id },
          summary: { method: 'password', sessionId: session.sessionId },
        });
        return { ...session, user: await requireUser(tx, user.id) };
      });
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: user.id });
      return { token: result.token, me: sessionMe(result.user, result.sessionId) };
    },

    async logout(principal, actor) {
      await deps.db.transaction(async (tx) => {
        await tx.delete(sessions).where(eq(sessions.id, principal.sessionId));
        await recordAudit(tx, actor, {
          action: 'auth.logout',
          target: { type: 'session', id: principal.sessionId },
        });
      });
    },

    me,

    async updateMe(principal, input, actor) {
      const id = principal.user.id;
      const patch = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.email === undefined ? {} : { email: input.email }),
      };
      try {
        await deps.db.transaction(async (tx) => {
          const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');
          if (!before) throw unauthorized();
          const [after] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
          if (!after) throw unauthorized();
          await recordAudit(tx, actor, {
            action: 'user.update',
            target: { type: 'user', id },
            summary: diffSummary(before, after, Object.keys(patch)),
          });
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('An account with this e-mail address already exists');
        }
        throw error;
      }
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: id });
      return me(principal);
    },

    async changePassword(principal, input, actor) {
      const id = principal.user.id;
      const [row] = await deps.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, id));
      if (!row) throw unauthorized();
      if (row.passwordHash !== null) {
        const current = input.currentPassword ?? '';
        if (!current || !(await verifyPassword(row.passwordHash, current))) {
          throw invalidField('body.currentPassword', 'The current password is incorrect');
        }
      }
      const passwordHash = await hashPassword(input.newPassword);
      await deps.db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash }).where(eq(users.id, id));
        // Other sessions may belong to whoever knew the old password.
        const ended = await tx
          .delete(sessions)
          .where(and(eq(sessions.userId, id), ne(sessions.id, principal.sessionId)))
          .returning({ id: sessions.id });
        await recordAudit(tx, actor, {
          action: 'user.change-password',
          target: { type: 'user', id },
          summary: { hadPassword: row.passwordHash !== null, endedSessions: ended.length },
        });
      });
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: id });
    },

    async listSessions(principal) {
      const rows = await deps.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, principal.user.id), gt(sessions.expiresAt, new Date())))
        .orderBy(desc(sessions.lastUsedAt), desc(sessions.id));
      const currentId = principal.kind === 'session' ? principal.sessionId : null;
      return {
        items: rows.map(
          (row): Session => ({
            id: row.id,
            current: row.id === currentId,
            ipAddress: row.ipAddress,
            userAgent: row.userAgent,
            createdAt: row.createdAt.toISOString(),
            lastUsedAt: row.lastUsedAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
          }),
        ),
      };
    },

    async revokeSession(principal, id, actor) {
      await deps.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.userId, principal.user.id)))
          .returning({ id: sessions.id });
        if (!deleted) throw notFound('Session not found');
        await recordAudit(tx, actor, {
          action: 'session.delete',
          target: { type: 'session', id },
        });
      });
    },
  };
}
