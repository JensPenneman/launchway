import type {
  PaginationQuery,
  UpdateUserInput,
  User,
  UserId,
  UserPage,
  UserRole,
} from '@slipway/contracts';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import { effectiveRole, getActorPrincipal, type RequestActor } from '../../lib/auth-context.js';
import { afterCursor, createdAtKey, toPage } from '../../lib/pagination.js';
import { conflict, notFound } from '../../lib/problem.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { passkeys } from '../auth/schema.js';
import { assertCanManageUser } from './rules.js';
import { users } from './schema.js';

type UserRow = typeof users.$inferSelect;
type UserRowWithCount = UserRow & { passkeyCount: number };

const passkeyCount = sql<number>`(select count(*)::int from ${passkeys} where ${passkeys.userId} = ${users.id})`;

/** Columns for `toUser`: the user row plus the number of passkeys. */
const userSelection = { ...getTableColumns(users), passkeyCount };

/** API shape of a user; never includes the password hash. */
export function toUser(row: UserRowWithCount): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    hasPassword: row.passwordHash !== null,
    passkeyCount: row.passkeyCount,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Loads one user in API shape (null when missing). */
export async function loadUser(db: Executor, id: UserId): Promise<User | null> {
  const [row] = await db.select(userSelection).from(users).where(eq(users.id, id));
  return row ? toUser(row) : null;
}

export interface NewUser {
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string | null;
}

/** Inserts a user (setup, invitations); a taken e-mail address is a 409. */
export async function insertUser(tx: Executor, input: NewUser): Promise<UserRow> {
  try {
    // A savepoint keeps the surrounding transaction usable when the insert fails.
    return await tx.transaction(async (sp) => {
      const [row] = await sp.insert(users).values(input).returning();
      if (!row) throw new Error('user insert returned no row');
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('An account with this e-mail address already exists');
    }
    throw error;
  }
}

export interface UsersService {
  list(query: PaginationQuery): Promise<UserPage>;
  get(id: UserId): Promise<User>;
  update(id: UserId, input: UpdateUserInput, actor: RequestActor): Promise<User>;
  remove(id: UserId, actor: RequestActor): Promise<void>;
}

export function createUsersService(deps: Pick<Deps, 'db' | 'events'>): UsersService {
  async function get(id: UserId): Promise<User> {
    const user = await loadUser(deps.db, id);
    if (!user) throw notFound('User not found');
    return user;
  }

  return {
    get,

    async list({ limit, cursor }) {
      const rows = await deps.db
        .select({ ...userSelection, createdAtKey: createdAtKey(users.createdAt) })
        .from(users)
        .where(afterCursor(cursor, users.createdAt, users.id, 'asc'))
        .orderBy(asc(users.createdAt), asc(users.id))
        .limit(limit + 1);
      return toPage(rows, limit, toUser);
    },

    async update(id, input, actor) {
      const principal = getActorPrincipal(actor);
      await deps.db.transaction(async (tx) => {
        const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!before) throw notFound('User not found');
        assertCanManageUser({ id: principal.user.id, role: effectiveRole(principal) }, before, {
          kind: 'update',
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.role === undefined ? {} : { role: input.role }),
        });
        const patch = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.role === undefined ? {} : { role: input.role }),
        };
        const [after] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
        if (!after) throw notFound('User not found');
        await recordAudit(tx, actor, {
          action: 'user.update',
          target: { type: 'user', id },
          summary: diffSummary(before, after, Object.keys(patch)),
        });
      });
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: id });
      return get(id);
    },

    async remove(id, actor) {
      const principal = getActorPrincipal(actor);
      await deps.db.transaction(async (tx) => {
        const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!target) throw notFound('User not found');
        assertCanManageUser({ id: principal.user.id, role: effectiveRole(principal) }, target, {
          kind: 'delete',
        });
        // Sessions, passkeys and API tokens go with the user (ON DELETE CASCADE).
        await tx.delete(users).where(eq(users.id, id));
        await recordAudit(tx, actor, {
          action: 'user.delete',
          target: { type: 'user', id },
          summary: { email: target.email, role: target.role },
        });
      });
      deps.events.publish({ topic: 'users', action: 'deleted', resourceId: id });
    },
  };
}
