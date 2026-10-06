import type { DnsProviderAccountId } from '@slipway/contracts';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';

/** Credentials for one DNS provider; `kind` is a provider registry key (`cloudflare`, `manual`). */
export const dnsProviderAccounts = pgTable('dns_provider_accounts', {
  id: idColumn('prov'),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  /** JSON credentials, encrypted (AAD `dns:<accountId>`). */
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  lastVerifiedAt: tz('last_verified_at'),
  ...timestamps(),
});

/** Zones discovered from a provider account. */
export const dnsZones = pgTable(
  'dns_zones',
  {
    id: idColumn('zone'),
    accountId: text('account_id')
      .$type<DnsProviderAccountId>()
      .notNull()
      .references(() => dnsProviderAccounts.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    /** Zone apex, lower-case (`example.com`). */
    name: text('name').notNull(),
    lastSyncedAt: tz('last_synced_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('dns_zones_account_id_external_id_key').on(t.accountId, t.externalId),
    index('dns_zones_name_idx').on(t.name),
  ],
);
