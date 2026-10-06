import type { UserId } from '@slipway/contracts';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { userRole, users } from '../users/schema.js';

/** Single-use invitation links (`slpi_...`, hashed at rest). */
export const invitations = pgTable(
  'invitations',
  {
    id: idColumn('inv'),
    /** Optional addressee (lower-case). */
    email: text('email'),
    role: userRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedById: text('invited_by_id')
      .$type<UserId>()
      .references(() => users.id, { onDelete: 'set null' }),
    acceptedById: text('accepted_by_id')
      .$type<UserId>()
      .references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tz('expires_at').notNull(),
    acceptedAt: tz('accepted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_key').on(t.tokenHash),
    index('invitations_expires_at_idx').on(t.expiresAt),
    check('invitations_role_not_owner', sql`${t.role} <> 'owner'`),
  ],
);
