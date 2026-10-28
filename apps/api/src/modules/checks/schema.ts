import {
  type AppId,
  CHECK_RUN_STATUSES,
  CHECK_RUN_TRIGGERS,
  type CheckRunId,
  type CheckRunReason,
  type GitHubCommitStatusState,
  type NodeId,
  type UserId,
} from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { apps } from '../apps/schema.js';
import { logStream } from '../deployments/schema.js';
import { nodes } from '../nodes/schema.js';
import { users } from '../users/schema.js';

export const checkRunStatus = pgEnum('check_run_status', CHECK_RUN_STATUSES);
export const checkRunTrigger = pgEnum('check_run_trigger', CHECK_RUN_TRIGGERS);

/**
 * One run of one configured check for one commit (ADR 0020). The check's configuration is a
 * snapshot taken when the run was queued; a node runs up to `settings.check_concurrency` of them at
 * once (the dispatcher counts them under a lock of the node, ADR 0021).
 */
export const checkRuns = pgTable(
  'check_runs',
  {
    id: idColumn('chk'),
    appId: text('app_id')
      .$type<AppId>()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** The app's node when the run was queued; the run stays there. */
    nodeId: text('node_id')
      .$type<NodeId>()
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    command: text('command').notNull(),
    service: text('service').notNull(),
    composeFiles: text('compose_files').array().notNull(),
    timeoutMinutes: integer('timeout_minutes').notNull(),
    commitSha: text('commit_sha').notNull(),
    /** Branch of the push or the pull request, or the ref of a manual run. */
    ref: text('ref'),
    prNumber: integer('pr_number'),
    trigger: checkRunTrigger('trigger').notNull(),
    status: checkRunStatus('status').notNull().default('queued'),
    /** Why the run ended (CHECK_RUN_REASONS); null while it has not. */
    reason: text('reason').$type<CheckRunReason>(),
    exitCode: integer('exit_code'),
    statusMessage: text('status_message'),
    /** State last posted to GitHub as the commit status `launchway/<name>`. */
    githubState: text('github_state').$type<GitHubCommitStatusState>(),
    triggeredById: text('triggered_by_id')
      .$type<UserId>()
      .references(() => users.id, { onDelete: 'set null' }),
    /** The commit's tree, read from GitHub when the run was queued; null when it could not be. */
    treeSha: text('tree_sha'),
    /** Reason `same-tree`: the finished run of the same check and tree whose result was reused. */
    copiedFromId: text('copied_from_id')
      .$type<CheckRunId>()
      .references((): AnyPgColumn => checkRuns.id, { onDelete: 'set null' }),
    /** Another branch whose push of the same commit this run serves (deduplicated into it). */
    alsoRef: text('also_ref'),
    /** When the run was sent to its node. */
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    ...timestamps(),
  },
  (t) => [
    index('check_runs_app_id_created_at_idx').on(t.appId, t.createdAt.desc()),
    index('check_runs_node_id_status_idx').on(t.nodeId, t.status),
    index('check_runs_app_id_commit_sha_idx').on(t.appId, t.commitSha),
    index('check_runs_app_id_tree_sha_idx')
      .on(t.appId, t.treeSha)
      .where(sql`${t.treeSha} IS NOT NULL`),
  ],
);

/** Output of a check run, streamed by the agent. Append-only; pruned after the retention period. */
export const checkLogLines = pgTable(
  'check_log_lines',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: text('run_id')
      .$type<CheckRunId>()
      .notNull()
      .references(() => checkRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    stream: logStream('stream').notNull(),
    line: text('line').notNull(),
    loggedAt: tz('logged_at').notNull(),
  },
  (t) => [
    uniqueIndex('check_log_lines_run_id_seq_key').on(t.runId, t.seq),
    index('check_log_lines_logged_at_idx').on(t.loggedAt),
  ],
);
