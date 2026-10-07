import { TOKEN_SCOPES, type UserId } from '@launchway/contracts';
import { index, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { users } from '../users/schema.js';

export const tokenScope = pgEnum('token_scope', TOKEN_SCOPES);

/** API tokens (`lwy_...`): SHA-256 hash at rest, plaintext shown once. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: idColumn('tok'),
    userId: text('user_id')
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenHint: text('token_hint').notNull(),
    scopes: tokenScope('scopes').array().notNull(),
    expiresAt: tz('expires_at'),
    lastUsedAt: tz('last_used_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_tokens_token_hash_key').on(t.tokenHash),
    index('api_tokens_user_id_idx').on(t.userId),
  ],
);
