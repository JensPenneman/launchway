import type { NodeId } from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, inet, pgTable, smallint, text } from 'drizzle-orm/pg-core';
import { timestamps, tz } from '../../db/columns.js';
import { nodes } from '../nodes/schema.js';

/** Platform settings: a single row (id = 1), created on first read. */
export const settings = pgTable(
  'settings',
  {
    id: smallint('id').primaryKey().default(1),
    /** Origin without trailing slash; LAUNCHWAY_PUBLIC_URL overrides it at runtime. */
    publicUrl: text('public_url'),
    acmeEmail: text('acme_email'),
    anchorHostname: text('anchor_hostname'),
    dynamicDnsEnabled: boolean('dynamic_dns_enabled').notNull().default(false),
    publicIpv4: inet('public_ipv4'),
    publicIpv4CheckedAt: tz('public_ipv4_checked_at'),
    forwardAuthUrl: text('forward_auth_url'),
    edgeNodeId: text('edge_node_id')
      .$type<NodeId>()
      .references(() => nodes.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [check('settings_singleton', sql`${t.id} = 1`)],
);
