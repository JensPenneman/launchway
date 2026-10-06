import { PASSKEY_DEVICE_TYPES, type UserId } from '@slipway/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  inet,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { bytea, idColumn, timestamps, tz } from '../../db/columns.js';
import { users } from '../users/schema.js';

/** UI sessions. The cookie carries a random token; only its SHA-256 hash is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: idColumn('sess'),
    userId: text('user_id')
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    /** Sliding: extended on use, 30 days after the last request. */
    expiresAt: tz('expires_at').notNull(),
    lastUsedAt: tz('last_used_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const passkeyDeviceType = pgEnum('passkey_device_type', PASSKEY_DEVICE_TYPES);

/** WebAuthn credentials (@simplewebauthn). */
export const passkeys = pgTable(
  'passkeys',
  {
    id: idColumn('pk'),
    userId: text('user_id')
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Credential ID, base64url. */
    credentialId: text('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    deviceType: passkeyDeviceType('device_type').notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    aaguid: text('aaguid'),
    lastUsedAt: tz('last_used_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('passkeys_credential_id_key').on(t.credentialId),
    index('passkeys_user_id_idx').on(t.userId),
  ],
);
