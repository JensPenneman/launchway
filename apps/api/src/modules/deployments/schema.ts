import {
  type AppId,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  type DeploymentFailureReason,
  type DeploymentId,
  LOG_STREAMS,
  type NodeId,
  type ServiceStatus,
  type UserId,
} from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { apps } from '../apps/schema.js';
import { nodes } from '../nodes/schema.js';
import { users } from '../users/schema.js';

export const deploymentStatus = pgEnum('deployment_status', DEPLOYMENT_STATUSES);
export const deploymentTrigger = pgEnum('deployment_trigger', DEPLOYMENT_TRIGGERS);
export const logStream = pgEnum('log_stream', LOG_STREAMS);

/** One attempt to run a ref of an app; status follows DEPLOYMENT_TRANSITIONS (contracts). */
export const deployments = pgTable(
  'deployments',
  {
    id: idColumn('dep'),
    appId: text('app_id')
      .$type<AppId>()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .$type<NodeId>()
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    trigger: deploymentTrigger('trigger').notNull().default('manual'),
    status: deploymentStatus('status').notNull().default('queued'),
    statusMessage: text('status_message'),
    triggeredById: text('triggered_by_id')
      .$type<UserId>()
      .references(() => users.id, { onDelete: 'set null' }),
    /** Classified cause of the last failed attempt (DEPLOYMENT_FAILURE_REASONS). */
    failureReason: text('failure_reason').$type<DeploymentFailureReason>(),
    /** Image retries scheduled so far (ADR 0019). */
    retryCount: integer('retry_count').notNull().default(0),
    /** A queued image retry is not dispatched before this. */
    nextAttemptAt: tz('next_attempt_at'),
    /** Per-service result reported by the agent. */
    services: jsonb('services').$type<ServiceStatus[]>().notNull().default(sql`'[]'::jsonb`),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    ...timestamps(),
  },
  (t) => [
    index('deployments_app_id_created_at_idx').on(t.appId, t.createdAt.desc()),
    index('deployments_status_idx').on(t.status),
    index('deployments_node_id_idx').on(t.nodeId),
    uniqueIndex('deployments_one_running_per_app').on(t.appId).where(sql`${t.status} = 'running'`),
  ],
);

/** Build/run output of a deployment, streamed by the agent. Append-only. */
export const deploymentLogLines = pgTable(
  'deployment_log_lines',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    deploymentId: text('deployment_id')
      .$type<DeploymentId>()
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    stream: logStream('stream').notNull(),
    line: text('line').notNull(),
    loggedAt: tz('logged_at').notNull(),
  },
  (t) => [uniqueIndex('deployment_log_lines_deployment_id_seq_key').on(t.deploymentId, t.seq)],
);
