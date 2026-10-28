import type { CheckRunTrigger } from '@launchway/contracts';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notExists,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Executor } from '../../db/client.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { recordAudit } from '../audit/service.js';
import { type CheckRunRow, formatDuration } from './model.js';
import { checkRuns } from './schema.js';

/**
 * Same-tree copies (ADR 0020): a push or pull request run whose commit has the tree of a commit
 * the same check already ran for gets that run's verdict instead of running again, so the merge
 * commit of an up-to-date pull request or a cherry-picked release commit is not checked twice.
 * The copy is a finished run of its own commit, so GitHub gets the statuses on that commit.
 */

/** Only results this recent are reused: older ones may rest on dependencies that moved since. */
export const COPY_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Triggers whose runs may be copies; manual, re-run and scheduled runs always run. */
export const COPYABLE_TRIGGERS = ['push', 'pull_request'] as const satisfies CheckRunTrigger[];

/** What a run must share with an earlier run to reuse its verdict. */
export type CopyKey = Pick<
  CheckRunRow,
  'appId' | 'treeSha' | 'name' | 'command' | 'service' | 'composeFiles' | 'timeoutMinutes'
>;

/** The runs of the same app, tree and check configuration (the snapshot taken when queued). */
function sameCheck(key: CopyKey & { treeSha: string }) {
  return and(
    eq(checkRuns.appId, key.appId),
    eq(checkRuns.treeSha, key.treeSha),
    eq(checkRuns.name, key.name),
    eq(checkRuns.command, key.command),
    eq(checkRuns.service, key.service),
    eq(checkRuns.composeFiles, key.composeFiles),
    eq(checkRuns.timeoutMinutes, key.timeoutMinutes),
  );
}

const running = alias(checkRuns, 'running');

/**
 * Queued runs that need not wait for their tree (ADR 0021): a push or pull request run with a
 * tree waits while a run of the same app, tree and check configuration runs on its node, since
 * that run's verdict becomes its own once it exits, as with one check per node at a time. Every
 * other run may go. For the claim's `WHERE` on `check_runs`.
 */
export function notWaitingForItsTree(tx: Executor): SQL | undefined {
  return or(
    notInArray(checkRuns.trigger, COPYABLE_TRIGGERS),
    isNull(checkRuns.treeSha),
    notExists(
      tx
        .select({ id: running.id })
        .from(running)
        .where(
          and(
            eq(running.nodeId, checkRuns.nodeId),
            eq(running.status, 'running'),
            eq(running.appId, checkRuns.appId),
            eq(running.treeSha, checkRuns.treeSha),
            eq(running.name, checkRuns.name),
            eq(running.command, checkRuns.command),
            eq(running.service, checkRuns.service),
            eq(running.composeFiles, checkRuns.composeFiles),
            eq(running.timeoutMinutes, checkRuns.timeoutMinutes),
          ),
        ),
    ),
  );
}

/** A verdict worth reusing: the command ran and exited (no timeout, error or cancellation). */
export function isCopySource(run: Pick<CheckRunRow, 'status' | 'reason' | 'treeSha'>): boolean {
  return (
    run.treeSha !== null &&
    run.reason === 'exit' &&
    (run.status === 'succeeded' || run.status === 'failed')
  );
}

/**
 * The newest run of the same app, tree and check configuration that ran and exited within
 * COPY_SOURCE_MAX_AGE_MS, or null. Copies are never sources (their reason is `same-tree`).
 */
export async function findCopySource(
  tx: Executor,
  key: CopyKey,
  now = new Date(),
): Promise<CheckRunRow | null> {
  if (key.treeSha === null) return null;
  const [source] = await tx
    .select()
    .from(checkRuns)
    .where(
      and(
        sameCheck({ ...key, treeSha: key.treeSha }),
        eq(checkRuns.reason, 'exit'),
        inArray(checkRuns.status, ['succeeded', 'failed']),
        gte(checkRuns.finishedAt, new Date(now.getTime() - COPY_SOURCE_MAX_AGE_MS)),
      ),
    )
    .orderBy(desc(checkRuns.finishedAt), desc(checkRuns.id))
    .limit(1);
  return source ?? null;
}

/** `Same tree as 3f78685, passed in 4m 18s` (also the GitHub description of the copy). */
export function sameTreeMessage(source: CheckRunRow): string {
  const start = source.startedAt ?? source.createdAt;
  const took = formatDuration((source.finishedAt ?? start).getTime() - start.getTime());
  const verdict =
    source.status === 'succeeded'
      ? `passed in ${took}`
      : source.exitCode === null
        ? `failed after ${took}`
        : `failed: exit code ${source.exitCode} after ${took}`;
  return `Same tree as ${source.commitSha.slice(0, 7)}, ${verdict}`;
}

/** The columns a run gets when it ends as a copy of `source`. */
export function copyOf(source: CheckRunRow, now = new Date()) {
  return {
    status: source.status,
    reason: 'same-tree' as const,
    exitCode: source.exitCode,
    statusMessage: sameTreeMessage(source),
    copiedFromId: source.id,
    finishedAt: now,
  };
}

/** Audits a queued run that ended as a copy (in the caller's transaction). */
export async function auditCopy(
  tx: Executor,
  actor: RequestActor,
  row: CheckRunRow,
  from: 'queued' | null,
): Promise<void> {
  await recordAudit(tx, actor, {
    action: row.status === 'succeeded' ? 'check.succeed' : 'check.fail',
    target: { type: 'check', id: row.id },
    summary: {
      appId: row.appId,
      name: row.name,
      commitSha: row.commitSha,
      status: { from, to: row.status },
      reason: 'same-tree',
      copiedFrom: row.copiedFromId,
    },
  });
}

/**
 * Once `source` ran and exited, its queued push and pull request runs of the same tree and check
 * become copies of it at once (audited, in the caller's transaction): they would only repeat it.
 * Returns them; announce them with `announceStatus` after commit.
 */
export async function copyQueuedRuns(
  tx: Executor,
  source: CheckRunRow,
  actor: RequestActor,
  now = new Date(),
): Promise<CheckRunRow[]> {
  if (!isCopySource(source) || source.treeSha === null) return [];
  const rows = await tx
    .update(checkRuns)
    .set(copyOf(source, now))
    .where(
      and(
        sameCheck({ ...source, treeSha: source.treeSha }),
        eq(checkRuns.status, 'queued'),
        inArray(checkRuns.trigger, COPYABLE_TRIGGERS),
      ),
    )
    .returning();
  for (const row of rows) await auditCopy(tx, actor, row, 'queued');
  return rows;
}
