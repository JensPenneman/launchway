import { type DockerInfo, NODE_STATUSES } from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import { inet, integer, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';

export const nodeStatus = pgEnum('node_status', NODE_STATUSES);

/** Machines running the agent. Credentials and join tokens are stored as SHA-256 hashes. */
export const nodes = pgTable(
  'nodes',
  {
    id: idColumn('node'),
    name: text('name').notNull(),
    status: nodeStatus('status').notNull().default('pending'),
    lanIp: inet('lan_ip'),
    hostname: text('hostname'),
    arch: text('arch'),
    agentVersion: text('agent_version'),
    protocolVersion: integer('protocol_version'),
    dockerInfo: jsonb('docker_info').$type<DockerInfo>(),
    /** Daemon-side directories trusted apps may bind-mount from (admin-controlled). */
    allowedBindRoots: text('allowed_bind_roots').array().notNull().default(sql`'{}'::text[]`),
    /** Long-lived node credential (`lwya_...`), issued on join; rotate by replacing. */
    credentialHash: text('credential_hash'),
    credentialIssuedAt: tz('credential_issued_at'),
    /** One-time join token (`lwyn_...`); expiry null only for the local bootstrap token. */
    joinTokenHash: text('join_token_hash'),
    joinTokenExpiresAt: tz('join_token_expires_at'),
    joinedAt: tz('joined_at'),
    lastSeenAt: tz('last_seen_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('nodes_name_key').on(t.name),
    uniqueIndex('nodes_credential_hash_key').on(t.credentialHash),
    uniqueIndex('nodes_join_token_hash_key').on(t.joinTokenHash),
  ],
);
