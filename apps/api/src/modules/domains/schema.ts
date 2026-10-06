import { type DnsZoneId, DOMAIN_STATUSES } from '@slipway/contracts';
import { boolean, index, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { dnsZones } from '../dns/schema.js';

export const domainStatus = pgEnum('domain_status', DOMAIN_STATUSES);

/** Fully-qualified names Slipway serves; bound to a zone when Slipway manages the record. */
export const domains = pgTable(
  'domains',
  {
    id: idColumn('dom'),
    /** Lower-case FQDN. */
    hostname: text('hostname').notNull(),
    zoneId: text('zone_id')
      .$type<DnsZoneId>()
      .references(() => dnsZones.id, { onDelete: 'set null' }),
    proxied: boolean('proxied').notNull().default(false),
    /** Render routes even when the DNS preflight fails. */
    force: boolean('force').notNull().default(false),
    status: domainStatus('status').notNull().default('pending'),
    statusMessage: text('status_message'),
    /** Provider id of the managed record (CNAME to the anchor by default). */
    dnsRecordExternalId: text('dns_record_external_id'),
    lastCheckedAt: tz('last_checked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('domains_hostname_key').on(t.hostname),
    index('domains_zone_id_idx').on(t.zoneId),
  ],
);
