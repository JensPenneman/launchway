import { USER_ROLES } from '@slipway/contracts';
import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';

export const userRole = pgEnum('user_role', USER_ROLES);

export const users = pgTable(
  'users',
  {
    id: idColumn('user'),
    /** Stored lower-case. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull(),
    /** argon2id; null for passkey-only accounts. */
    passwordHash: text('password_hash'),
    lastLoginAt: tz('last_login_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    // Exactly one owner: the account created by the first-run setup.
    uniqueIndex('users_single_owner_key').on(t.role).where(sql`${t.role} = 'owner'`),
  ],
);
