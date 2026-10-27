import {
  DEFAULT_CHECK_CPUS,
  DEFAULT_CHECK_MAX_QUEUED_PER_APP,
  DEFAULT_CHECK_MAX_QUEUED_PER_NODE,
  DEFAULT_CHECK_MEMORY_MB,
  DEFAULT_CHECK_PIDS_LIMIT,
  DEFAULT_PREVIEW_MAX_PER_APP,
  DEFAULT_PREVIEW_MAX_TOTAL,
  type ForwardAuthTarget,
  type NodeId,
} from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
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
    /** Forward-auth gate run as an app service (`ForwardAuthTarget`); XOR forward_auth_url. */
    forwardAuthTarget: jsonb('forward_auth_target').$type<ForwardAuthTarget>(),
    edgeNodeId: text('edge_node_id')
      .$type<NodeId>()
      .references(() => nodes.id, { onDelete: 'set null' }),
    /** Base domain of preview host names; validated against the managed zones on save. */
    previewBaseDomain: text('preview_base_domain'),
    previewMaxPerApp: integer('preview_max_per_app').notNull().default(DEFAULT_PREVIEW_MAX_PER_APP),
    previewMaxTotal: integer('preview_max_total').notNull().default(DEFAULT_PREVIEW_MAX_TOTAL),
    /** Caps of every service of a check run (ADR 0020). */
    checkMemoryMb: integer('check_memory_mb').notNull().default(DEFAULT_CHECK_MEMORY_MB),
    checkCpus: doublePrecision('check_cpus').notNull().default(DEFAULT_CHECK_CPUS),
    checkPidsLimit: integer('check_pids_limit').notNull().default(DEFAULT_CHECK_PIDS_LIMIT),
    /** Bounds of the check queue: runs beyond them end at once (reason queue-full). */
    checkMaxQueuedPerApp: integer('check_max_queued_per_app')
      .notNull()
      .default(DEFAULT_CHECK_MAX_QUEUED_PER_APP),
    checkMaxQueuedPerNode: integer('check_max_queued_per_node')
      .notNull()
      .default(DEFAULT_CHECK_MAX_QUEUED_PER_NODE),
    ...timestamps(),
  },
  (t) => [
    check('settings_singleton', sql`${t.id} = 1`),
    check(
      'settings_one_forward_auth',
      sql`${t.forwardAuthUrl} IS NULL OR ${t.forwardAuthTarget} IS NULL`,
    ),
  ],
);
