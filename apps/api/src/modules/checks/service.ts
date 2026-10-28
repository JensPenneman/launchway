import {
  type AppChecksSettings,
  type AppId,
  CHECK_LOG_RETENTION_MS,
  type CheckItem,
  type CheckLogsQuery,
  type CheckRun,
  type CheckRunId,
  type CheckRunList,
  type CheckRunListQuery,
  type CheckRunPage,
  type CheckRunStatus,
  type CheckRunTrigger,
  type CreateCheckRunsInput,
  isActiveCheckRunStatus,
  type NodeId,
  type Settings,
} from '@launchway/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import type { Deps } from '../../deps.js';
import { AgentRequestError, AgentUnavailableError } from '../../lib/agent-gateway.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { systemActor } from '../../lib/auth-context.js';
import { GitProviderError } from '../../lib/git-provider.js';
import { logStream } from '../../lib/log-stream.js';
import { afterCursor, createdAtKey, toPage } from '../../lib/pagination.js';
import { conflict, invalidField, notFound, ProblemError } from '../../lib/problem.js';
import type { SseMessage } from '../../lib/sse.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { getConnection, providerFor, toGitProblem } from '../github/providers.js';
import { nodes } from '../nodes/schema.js';
import { createSettingsService } from '../settings/service.js';
import { auditCopy, COPYABLE_TRIGGERS, copyOf, findCopySource } from './copies.js';
import { createCheckDispatcher } from './dispatcher.js';
import {
  announceCreated,
  announceStatus,
  BRANCH_DELETED_PREFIX,
  type CheckRunRow,
  checkLogHub,
  checksSettingsOf,
  runSnapshot,
  toCheckRun,
} from './model.js';
import { checkLogLines, checkRuns } from './schema.js';

type AppRow = typeof apps.$inferSelect;
type QueueLimits = Pick<Settings, 'checkMaxQueuedPerApp' | 'checkMaxQueuedPerNode'>;

export const CANCELLED_MESSAGE = 'Cancelled';
export const CANCEL_REQUESTED_MESSAGE = 'Cancellation requested';
export const APP_DELETED_MESSAGE = 'Cancelled: the app is being deleted';
export const APP_MOVED_MESSAGE = 'Cancelled: the app moved to another node';
/** Log lines deleted per statement when pruning. */
const PRUNE_BATCH = 5000;

/** The commit a push or a pull request of the app's repository runs the checks for. */
export interface CommitTarget {
  readonly sha: string;
  /** The pushed branch, or the head branch of the pull request. */
  readonly ref: string;
  readonly prNumber: number | null;
  readonly trigger: Exclude<CheckRunTrigger, 'manual' | 'schedule'>;
  /** The commit's tree when the event names it (pushes); otherwise it is read from GitHub. */
  readonly treeSha?: string | null;
}

/** A pull request of the app's repository that was closed or merged. */
export interface ClosedPullRequest {
  readonly number: number;
  /** Its head branch: the ref its runs carry. */
  readonly headRef: string;
  readonly merged: boolean;
  /** GitHub's `closed_at`: runs queued later (after a reopen) are not its closed runs. */
  readonly closedAt: Date;
  /** The repository's default branch from the event; read from GitHub when null. */
  readonly defaultBranch: string | null;
}

/** A branch of the app's repository that was deleted. */
export interface DeletedBranch {
  readonly name: string;
  /** The commit the branch pointed at (`before` of the push event). */
  readonly headSha: string;
  /** The repository's default branch from the event; read from GitHub when null. */
  readonly defaultBranch: string | null;
}

/** What a slot of the check schedule did. */
export type ScheduledOutcome =
  | { readonly kind: 'queued'; readonly runs: CheckRun[] }
  /** Nothing queued: the slot ran already, the schedule changed, or the checks still run. */
  | { readonly kind: 'none' }
  /** Nothing queued for a reason the app's Checks tab shows (`checksScheduleNote`). */
  | { readonly kind: 'skipped'; readonly note: string };

/** `2026-11-02 06:00` (UTC), how notes about a slot name it. */
export function slotLabel(slot: Date): string {
  return `${slot.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface ChecksService {
  /** Runs of an app, newest first. */
  list(appId: AppId, query: CheckRunListQuery): Promise<CheckRunPage>;
  get(id: CheckRunId): Promise<CheckRun>;
  /**
   * Runs the app's checks (or the named ones) for a ref resolved to a commit, skipping checks
   * that are queued or running for that commit already. Needs no `checks.enabled`.
   */
  createManual(
    appId: AppId,
    input: CreateCheckRunsInput,
    actor: RequestActor,
  ): Promise<CheckRunList>;
  /**
   * Webhooks: queues one run per configured check for a pushed commit or a pull request head;
   * checks that ran for the commit already (any status) are skipped. Queued push and pull request
   * runs of the same ref for another commit are superseded. Returns the new runs.
   */
  queueForCommit(app: AppRow, commit: CommitTarget, actor: RequestActor): Promise<CheckRun[]>;
  /**
   * Webhooks: a pull request was closed or merged. The queued runs it started (trigger
   * `pull_request`, its number, its head branch, queued before `closed_at`) are cancelled
   * (reason `closed`), unless they also serve a push, another open pull request has the same
   * head, or the head branch is the default branch. Running runs finish, so a merged pull
   * request's result can still serve the merge commit of the same tree. Returns them.
   */
  closePullRequest(app: AppRow, pr: ClosedPullRequest, actor: RequestActor): Promise<CheckRun[]>;
  /**
   * Webhooks: a branch was deleted. The queued runs of the branch for the commit it pointed at
   * are cancelled (reason `closed`), unless they also serve another branch's push or an open pull
   * request from another branch at that commit needs them (they become its runs); the default
   * branch is never touched. Returns the cancelled runs.
   */
  closeBranch(app: AppRow, branch: DeletedBranch, actor: RequestActor): Promise<CheckRun[]>;
  /**
   * The check schedule: queues the checks for the head of the default branch for the slot, once
   * per slot (a slot at or before the app's last one, or a changed schedule, queues nothing). A
   * full queue uses the slot without queueing; the note says why.
   */
  queueScheduled(app: AppRow, slot: Date, schedule: string): Promise<ScheduledOutcome>;
  /** Uses a slot of the check schedule without queueing anything, noting why. */
  skipScheduled(app: AppRow, slot: Date, schedule: string, note: string): Promise<void>;
  /** Cancels a queued run at once, a running one through its node; answers the run. */
  cancel(id: CheckRunId, actor: RequestActor): Promise<CheckRun>;
  /**
   * A new run of a finished run's check for the same commit, with the check's current config
   * (trigger `manual`; a scheduled run's re-run stays `schedule`, so it reports where it did).
   */
  rerun(id: CheckRunId, actor: RequestActor): Promise<CheckRun>;
  /** SSE source of `GET /checks/{id}/logs`: history, then live lines while queued or running. */
  logStream(id: CheckRunId, query: CheckLogsQuery, signal: AbortSignal): AsyncIterable<SseMessage>;
  /**
   * Before an app is deleted: cancels its queued runs, and its running runs on their nodes (best
   * effort) and here.
   */
  cancelForApp(appId: AppId, actor: RequestActor): Promise<void>;
  /** Deletes log lines older than CHECK_LOG_RETENTION_MS (the runs stay); returns the count. */
  pruneLogs(now?: Date): Promise<number>;
}

interface Cancellation {
  readonly reason: 'cancelled' | 'superseded' | 'closed';
  readonly message: string;
  /** Extra audit summary fields. */
  readonly summary?: Record<string, unknown>;
}

/**
 * Cancels the queued runs matching `where` (audited, in the caller's transaction). Returns them;
 * announce them with `announceStatus` after commit.
 */
async function cancelQueued(
  tx: Executor,
  where: SQL | undefined,
  cancellation: Cancellation,
  actor: RequestActor,
): Promise<CheckRunRow[]> {
  const rows = await tx
    .update(checkRuns)
    .set({
      status: 'cancelled',
      reason: cancellation.reason,
      statusMessage: cancellation.message,
      finishedAt: new Date(),
    })
    .where(and(eq(checkRuns.status, 'queued'), where))
    .returning();
  for (const row of rows) {
    await recordAudit(tx, actor, {
      action: 'check.cancel',
      target: { type: 'check', id: row.id },
      summary: {
        appId: row.appId,
        name: row.name,
        status: { from: 'queued', to: 'cancelled' },
        reason: cancellation.message,
        ...cancellation.summary,
      },
    });
  }
  return rows;
}

/**
 * An app moves to another node: its queued runs of the old node are cancelled in the caller's
 * transaction (running ones finish there). Announce the returned runs after commit.
 */
export function cancelQueuedOnNode(
  tx: Executor,
  appId: AppId,
  nodeId: NodeId,
  actor: RequestActor,
): Promise<CheckRunRow[]> {
  return cancelQueued(
    tx,
    and(eq(checkRuns.appId, appId), eq(checkRuns.nodeId, nodeId)),
    { reason: 'cancelled', message: APP_MOVED_MESSAGE },
    actor,
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function messageOf(error: unknown): string {
  if (error instanceof ProblemError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : 'unknown error';
}

export function createChecksService(deps: Deps): ChecksService {
  const logger = deps.logger.child({ component: 'checks' });
  const dispatcher = createCheckDispatcher(deps);
  const hub = checkLogHub(deps.events);
  const platform = createSettingsService(deps);

  /** The bounds of the queue, read before a transaction: never while it holds row locks. */
  async function queueLimits(): Promise<QueueLimits> {
    const { checkMaxQueuedPerApp, checkMaxQueuedPerNode } = await platform.get();
    return { checkMaxQueuedPerApp, checkMaxQueuedPerNode };
  }

  /**
   * Why `adding` more runs would overfill the queue of the app or of its node, or null when they
   * fit. Locks the node row, so apps of one node count one after another; call it after the app
   * row is locked.
   */
  async function queueFull(
    tx: Executor,
    app: AppRow,
    adding: number,
    limits: QueueLimits,
  ): Promise<string | null> {
    await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, app.nodeId)).for('update');
    const queuedOf = async (where: SQL | undefined) => {
      const [row] = await tx
        .select({ value: count() })
        .from(checkRuns)
        .where(and(eq(checkRuns.status, 'queued'), where));
      return Number(row?.value ?? 0);
    };
    // `28 queued and 5 new checks would exceed the app's limit of 30`.
    const exceeded = (queued: number, whose: string, limit: number) =>
      `${queued} queued and ${adding} new check${adding === 1 ? '' : 's'} would exceed ${whose} limit of ${limit}`;
    const ofApp = await queuedOf(eq(checkRuns.appId, app.id));
    if (ofApp + adding > limits.checkMaxQueuedPerApp) {
      return exceeded(ofApp, "the app's", limits.checkMaxQueuedPerApp);
    }
    const ofNode = await queuedOf(eq(checkRuns.nodeId, app.nodeId));
    if (ofNode + adding > limits.checkMaxQueuedPerNode) {
      return exceeded(ofNode, "its node's", limits.checkMaxQueuedPerNode);
    }
    return null;
  }

  async function loadApp(appId: AppId): Promise<AppRow> {
    const [app] = await deps.db.select().from(apps).where(eq(apps.id, appId));
    if (!app) throw notFound('App not found');
    return app;
  }

  /** The app row, locked: serializes queueing, cancelling for the app and its settings. */
  async function lockApp(tx: Executor, appId: AppId): Promise<AppRow> {
    const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update');
    if (!app) throw notFound('App not found');
    return app;
  }

  async function loadRow(id: CheckRunId): Promise<CheckRunRow> {
    const [row] = await deps.db.select().from(checkRuns).where(eq(checkRuns.id, id));
    if (!row) throw notFound('Check run not found');
    return row;
  }

  async function resolveCommit(app: AppRow, ref: string): Promise<string> {
    const connection = await getConnection(deps.db, app.connectionId);
    try {
      return (await providerFor(deps, connection).resolveRef(app.repoOwner, app.repoName, ref)).sha;
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') {
        throw invalidField('body.ref', `Ref not found in ${app.repoOwner}/${app.repoName}`);
      }
      throw toGitProblem(error);
    }
  }

  /**
   * The tree of a commit of the app's repository, or null when GitHub cannot tell (the run is
   * then never a copy, nor copied from).
   */
  async function treeOf(app: AppRow, sha: string): Promise<string | null> {
    try {
      const connection = await getConnection(deps.db, app.connectionId);
      return await providerFor(deps, connection).commitTree(app.repoOwner, app.repoName, sha);
    } catch (error) {
      logger.warn(
        { appId: app.id, commitSha: sha, reason: messageOf(error) },
        'could not read the tree of a commit; its checks run without same-tree copies',
      );
      return null;
    }
  }

  /** The repository's default branch, or null when GitHub cannot tell (then nothing is cancelled). */
  async function defaultBranchOf(app: AppRow): Promise<string | null> {
    try {
      const connection = await getConnection(deps.db, app.connectionId);
      return await providerFor(deps, connection).defaultBranch(app.repoOwner, app.repoName);
    } catch (error) {
      logger.warn(
        { appId: app.id, reason: messageOf(error) },
        'could not read the default branch; no checks are cancelled',
      );
      return null;
    }
  }

  /** Open pull requests of the repository with this head, or null when GitHub cannot tell. */
  async function openPullRequestsWithHead(
    app: AppRow,
    sha: string,
  ): Promise<{ number: number; headRef: string }[] | null> {
    try {
      const connection = await getConnection(deps.db, app.connectionId);
      return await providerFor(deps, connection).openPullRequestsWithHead(
        app.repoOwner,
        app.repoName,
        sha,
      );
    } catch (error) {
      logger.warn(
        { appId: app.id, commitSha: sha, reason: messageOf(error) },
        'could not list the pull requests of a commit; its queued checks stay',
      );
      return null;
    }
  }

  /** Scheduler state of the app, not a change of it: its updatedAt stays. */
  async function markSlot(tx: Executor, appId: AppId, slot: Date, note: string | null) {
    await tx.execute(
      sql`UPDATE apps SET checks_last_slot = ${slot}, checks_schedule_note = ${note} WHERE id = ${appId}`,
    );
  }

  /**
   * How many runs of their node are running or queued before each queued run (the dispatcher
   * sends the oldest first), for the runs given.
   */
  async function queuePositions(rows: readonly CheckRunRow[]): Promise<Map<CheckRunId, number>> {
    const positions = new Map<CheckRunId, number>();
    const queued = rows.filter((row) => row.status === 'queued');
    if (queued.length === 0) return positions;
    const active = await deps.db
      .select({ id: checkRuns.id, nodeId: checkRuns.nodeId, status: checkRuns.status })
      .from(checkRuns)
      .where(
        and(
          inArray(checkRuns.nodeId, [...new Set(queued.map((row) => row.nodeId))]),
          inArray(checkRuns.status, ['queued', 'running']),
        ),
      )
      .orderBy(asc(checkRuns.createdAt), asc(checkRuns.id));
    // A running run is ahead of every queued one; queued ones go oldest first.
    const ahead = new Map<NodeId, number>();
    for (const run of active) {
      if (run.status === 'running') ahead.set(run.nodeId, (ahead.get(run.nodeId) ?? 0) + 1);
    }
    for (const run of active) {
      if (run.status !== 'queued') continue;
      const before = ahead.get(run.nodeId) ?? 0;
      positions.set(run.id, before);
      ahead.set(run.nodeId, before + 1);
    }
    return positions;
  }

  async function withPositions(rows: readonly CheckRunRow[]): Promise<CheckRun[]> {
    const positions = await queuePositions(rows);
    return rows.map((row) => toCheckRun(row, positions.get(row.id) ?? null));
  }

  /**
   * A push or pull request of a commit whose checks ran or run already: those runs serve it too,
   * and say so. A push of another branch becomes the run's `alsoRef` (so neither closing its pull
   * request nor a newer commit of its own branch cancels what that branch needs), a push of a
   * pull request run's own branch makes it a push run, and a pull request becomes the run's
   * `prNumber` when it has none. Returns the runs changed (publish after commit).
   */
  async function serveExisting(
    tx: Executor,
    existing: readonly CheckRunRow[],
    commit: CommitTarget,
  ): Promise<CheckRunRow[]> {
    const changed: CheckRunRow[] = [];
    for (const row of existing) {
      const set =
        commit.trigger === 'push' && row.ref !== commit.ref && row.alsoRef === null
          ? { alsoRef: commit.ref }
          : commit.trigger === 'push' && row.ref === commit.ref && row.trigger === 'pull_request'
            ? // The push of its own branch: closing the pull request no longer cancels it.
              { trigger: 'push' as const }
            : commit.trigger === 'pull_request' && row.prNumber === null
              ? { prNumber: commit.prNumber }
              : null;
      if (!set) continue;
      const [updated] = await tx
        .update(checkRuns)
        .set(set)
        .where(eq(checkRuns.id, row.id))
        .returning();
      if (updated) changed.push(updated);
    }
    return changed;
  }

  /** Names of the app's checks with a queued or running run for the commit. */
  async function activeNames(tx: Executor, appId: AppId, sha: string): Promise<Set<string>> {
    const rows = await tx
      .select({ name: checkRuns.name })
      .from(checkRuns)
      .where(
        and(
          eq(checkRuns.appId, appId),
          eq(checkRuns.commitSha, sha),
          inArray(checkRuns.status, ['queued', 'running']),
        ),
      );
    return new Set(rows.map((row) => row.name));
  }

  /** Inserts one queued run per check on the app's node (audited, in the transaction). */
  async function insertRuns(
    tx: Executor,
    app: AppRow,
    settings: AppChecksSettings,
    items: readonly CheckItem[],
    commit: {
      sha: string;
      ref: string | null;
      prNumber: number | null;
      trigger: CheckRunTrigger;
      treeSha: string | null;
    },
    actor: RequestActor,
    summary: Record<string, unknown> = {},
    /** Set when the queue is full: the runs end at once, so GitHub shows why. */
    full: string | null = null,
  ): Promise<CheckRunRow[]> {
    if (items.length === 0) return [];
    const createdAt = new Date();
    const ended = full
      ? {
          status: 'errored' as const,
          reason: 'queue-full' as const,
          statusMessage: `Not run: ${full}; run it again later`,
          finishedAt: createdAt,
        }
      : {};
    const rows = await tx
      .insert(checkRuns)
      .values(
        items.map((item) => ({
          appId: app.id,
          nodeId: app.nodeId,
          ...runSnapshot(item, settings),
          commitSha: commit.sha,
          ref: commit.ref,
          prNumber: commit.prNumber,
          trigger: commit.trigger,
          treeSha: commit.treeSha,
          triggeredById: actor.principal?.user.id ?? null,
          createdAt,
          ...ended,
        })),
      )
      .returning();
    for (const row of rows) {
      await recordAudit(tx, actor, {
        action: 'check.create',
        target: { type: 'check', id: row.id },
        summary: {
          appId: app.id,
          name: row.name,
          commitSha: row.commitSha,
          ref: row.ref,
          trigger: row.trigger,
          ...(row.prNumber === null ? {} : { prNumber: row.prNumber }),
          ...(full ? { status: row.status, reason: row.reason } : {}),
          ...summary,
        },
      });
    }
    return rows;
  }

  /**
   * Inserts runs that end at once as copies of a finished run of the same tree (audited, in the
   * transaction): they post their statuses like any finished run.
   */
  async function insertCopies(
    tx: Executor,
    app: AppRow,
    settings: AppChecksSettings,
    copies: readonly { item: CheckItem; source: CheckRunRow }[],
    commit: CommitTarget & { treeSha: string },
    actor: RequestActor,
  ): Promise<CheckRunRow[]> {
    if (copies.length === 0) return [];
    const now = new Date();
    const rows = await tx
      .insert(checkRuns)
      .values(
        copies.map(({ item, source }) => ({
          appId: app.id,
          nodeId: app.nodeId,
          ...runSnapshot(item, settings),
          commitSha: commit.sha,
          ref: commit.ref,
          prNumber: commit.prNumber,
          trigger: commit.trigger,
          treeSha: commit.treeSha,
          triggeredById: actor.principal?.user.id ?? null,
          createdAt: now,
          ...copyOf(source, now),
        })),
      )
      .returning();
    for (const row of rows) await auditCopy(tx, actor, row, null);
    return rows;
  }

  /** After commit: announces new runs and sends the node's next run in the background. */
  function queued(rows: readonly CheckRunRow[], nodeId: NodeId): void {
    for (const row of rows) announceCreated(deps, row);
    if (rows.some((row) => row.status === 'queued')) void dispatcher.dispatchNode(nodeId);
  }

  /** Cancels a queued or running run here (audited); undefined when its status changed. */
  async function cancelLocally(
    row: CheckRunRow,
    from: 'queued' | 'running',
    message: string,
    actor: RequestActor,
  ): Promise<CheckRunRow | undefined> {
    const updated = await deps.db.transaction(async (tx) => {
      const [changed] = await tx
        .update(checkRuns)
        .set({
          status: 'cancelled',
          reason: 'cancelled',
          statusMessage: message,
          finishedAt: new Date(),
        })
        .where(and(eq(checkRuns.id, row.id), eq(checkRuns.status, from)))
        .returning();
      if (changed) {
        await recordAudit(tx, actor, {
          action: 'check.cancel',
          target: { type: 'check', id: row.id },
          summary: {
            appId: row.appId,
            name: row.name,
            status: { from, to: 'cancelled' },
            reason: message,
          },
        });
      }
      return changed;
    });
    if (!updated) return undefined;
    announceStatus(deps, updated);
    // A running run held the node: the next one may go.
    if (from === 'running') void dispatcher.dispatchNode(row.nodeId);
    return updated;
  }

  /** Asks the node to stop a running run; the agent's `cancelled` result settles it. */
  async function cancelRunning(row: CheckRunRow, actor: RequestActor): Promise<CheckRun> {
    try {
      await deps.agents.cancelCheck(row.nodeId, row.id);
    } catch (error) {
      // The node is gone or does not have the run, so nothing runs it any more. A run the
      // dispatcher put back in the queue meanwhile (its node went away) is cancelled there.
      if (
        error instanceof AgentUnavailableError ||
        (error instanceof AgentRequestError && error.code === 'not-found')
      ) {
        const cancelled =
          (await cancelLocally(row, 'running', CANCELLED_MESSAGE, actor)) ??
          (await cancelLocally(row, 'queued', CANCELLED_MESSAGE, actor));
        return toCheckRun(cancelled ?? (await loadRow(row.id)));
      }
      throw new ProblemError('upstream-failed', {
        detail: 'The node did not confirm the cancellation',
        cause: error,
      });
    }
    const annotated = await deps.db.transaction(async (tx) => {
      // The agent's result may have landed already: only annotate a run still running.
      const [changed] = await tx
        .update(checkRuns)
        .set({ statusMessage: CANCEL_REQUESTED_MESSAGE })
        .where(and(eq(checkRuns.id, row.id), eq(checkRuns.status, 'running')))
        .returning();
      await recordAudit(tx, actor, {
        action: 'check.cancel',
        target: { type: 'check', id: row.id },
        summary: { appId: row.appId, name: row.name, requested: true, status: row.status },
      });
      return changed;
    });
    if (!annotated) return toCheckRun(await loadRow(row.id));
    deps.events.publish({
      topic: 'checks',
      action: 'updated',
      resourceId: row.id,
      data: { appId: row.appId, status: annotated.status },
    });
    return toCheckRun(annotated);
  }

  function assertActive(row: CheckRunRow): void {
    if (!isActiveCheckRunStatus(row.status)) {
      throw conflict(
        `The check run is ${row.status}; only queued or running runs can be cancelled`,
      );
    }
  }

  return {
    async list(appId, query) {
      await loadApp(appId);
      const conditions: (SQL | undefined)[] = [
        eq(checkRuns.appId, appId),
        afterCursor(query.cursor, checkRuns.createdAt, checkRuns.id, 'desc'),
      ];
      if (query.status) conditions.push(eq(checkRuns.status, query.status));
      if (query.name) conditions.push(eq(checkRuns.name, query.name));
      if (query.commitSha) conditions.push(eq(checkRuns.commitSha, query.commitSha));
      const rows = await deps.db
        .select({
          row: checkRuns,
          id: checkRuns.id,
          createdAtKey: createdAtKey(checkRuns.createdAt),
        })
        .from(checkRuns)
        .where(and(...conditions))
        .orderBy(desc(checkRuns.createdAt), desc(checkRuns.id))
        .limit(query.limit + 1);
      const positions = await queuePositions(rows.map((r) => r.row));
      return toPage(rows, query.limit, (r) => toCheckRun(r.row, positions.get(r.row.id) ?? null));
    },

    async get(id) {
      const [run] = await withPositions([await loadRow(id)]);
      if (!run) throw notFound('Check run not found');
      return run;
    },

    async createManual(appId, input, actor) {
      const app = await loadApp(appId);
      const configured = checksSettingsOf(app).items;
      if (configured.length === 0) {
        throw conflict('This app has no checks; configure them in its settings first');
      }
      const names = input.names ?? configured.map((item) => item.name);
      const unknown = names.filter((name) => !configured.some((item) => item.name === name));
      if (unknown.length > 0) {
        throw invalidField(
          'body.names',
          `Unknown check${unknown.length === 1 ? '' : 's'} ${unknown.map((name) => `"${name}"`).join(', ')}`,
        );
      }
      const sha = await resolveCommit(app, input.ref);
      const treeSha = await treeOf(app, sha);
      const limits = await queueLimits();
      const { rows, nodeId } = await deps.db.transaction(async (tx) => {
        const locked = await lockApp(tx, appId);
        const settings = checksSettingsOf(locked);
        const busy = await activeNames(tx, appId, sha);
        const items = settings.items.filter(
          (item) => names.includes(item.name) && !busy.has(item.name),
        );
        if (items.length === 0) {
          throw conflict(`Every requested check already runs for ${shortSha(sha)}`);
        }
        const full = await queueFull(tx, locked, items.length, limits);
        if (full) throw conflict(`Not queued: ${full}; wait for them or raise the limit`);
        const commit = { sha, ref: input.ref, prNumber: null, trigger: 'manual' as const, treeSha };
        return {
          rows: await insertRuns(tx, locked, settings, items, commit, actor),
          nodeId: locked.nodeId,
        };
      });
      logger.info(
        { appId, commitSha: sha, checks: rows.map((row) => row.name) },
        'check runs queued',
      );
      queued(rows, nodeId);
      return { items: await withPositions(rows) };
    },

    async queueForCommit(app, commit, actor) {
      const treeSha = commit.treeSha !== undefined ? commit.treeSha : await treeOf(app, commit.sha);
      const limits = await queueLimits();
      const result = await deps.db.transaction(async (tx) => {
        const locked = await lockApp(tx, app.id);
        const settings = checksSettingsOf(locked);
        // Concurrent and repeated deliveries of one commit queue each check once; runs that never
        // ran (superseded by another commit of the branch, not queued while the queue was full,
        // cancelled because their pull request closed, or ended while their node was offline
        // before it took them) do not count, so the commit runs when it is pushed again.
        const existing = await tx
          .select()
          .from(checkRuns)
          .where(
            and(
              eq(checkRuns.appId, app.id),
              eq(checkRuns.commitSha, commit.sha),
              or(
                isNull(checkRuns.reason),
                and(
                  notInArray(checkRuns.reason, ['superseded', 'queue-full', 'closed']),
                  or(ne(checkRuns.reason, 'offline'), isNotNull(checkRuns.startedAt)),
                ),
              ),
            ),
          );
        const served = await serveExisting(tx, existing, commit);
        const seen = new Set(existing.map((row) => row.name));
        const items = settings.items.filter((item) => !seen.has(item.name));
        if (items.length === 0)
          return { rows: [], superseded: [], served, nodeId: locked.nodeId, full: null };
        // A check that ran and exited for a commit of the same tree is not run again.
        const copies: { item: CheckItem; source: CheckRunRow }[] = [];
        const run: CheckItem[] = [];
        for (const item of items) {
          const source = await findCopySource(tx, {
            appId: app.id,
            treeSha,
            ...runSnapshot(item, settings),
          });
          if (source) copies.push({ item, source });
          else run.push(item);
        }
        // Runs of an older commit of the branch that no node has yet are outdated by this one;
        // a run that also serves a push of another branch stays for that branch.
        const superseded = await cancelQueued(
          tx,
          and(
            eq(checkRuns.appId, app.id),
            eq(checkRuns.ref, commit.ref),
            or(isNull(checkRuns.alsoRef), eq(checkRuns.alsoRef, commit.ref)),
            inArray(checkRuns.trigger, COPYABLE_TRIGGERS),
            ne(checkRuns.commitSha, commit.sha),
          ),
          {
            reason: 'superseded',
            message: `Superseded by ${commit.sha.slice(0, 12)}`,
            summary: { supersededBy: commit.sha },
          },
          actor,
        );
        // Pushes to many branches must not queue without bound, each holding a pending status.
        const full = run.length === 0 ? null : await queueFull(tx, locked, run.length, limits);
        const target = { ...commit, treeSha };
        const rows = [
          ...(treeSha === null
            ? []
            : await insertCopies(tx, locked, settings, copies, { ...target, treeSha }, actor)),
          ...(await insertRuns(tx, locked, settings, run, target, actor, {}, full)),
        ];
        return { rows, superseded, served, nodeId: locked.nodeId, full };
      });
      for (const row of result.superseded) announceStatus(deps, row);
      // No status: the commit status mirror has nothing to post for these.
      for (const row of result.served) {
        deps.events.publish({
          topic: 'checks',
          action: 'updated',
          resourceId: row.id,
          data: { appId: row.appId },
        });
      }
      if (result.rows.length === 0) return [];
      logger.info(
        {
          appId: app.id,
          commitSha: commit.sha,
          trigger: commit.trigger,
          checks: result.rows.map((row) => row.name),
          copies: result.rows.filter((row) => row.reason === 'same-tree').length,
          superseded: result.superseded.length,
          ...(result.full ? { notQueued: result.full } : {}),
        },
        result.full ? 'check runs not queued: the queue is full' : 'check runs queued',
      );
      queued(result.rows, result.nodeId);
      return result.rows.map((row) => toCheckRun(row));
    },

    async closePullRequest(app, pr, actor) {
      // The default branch always needs its checks.
      const defaultBranch = pr.defaultBranch ?? (await defaultBranchOf(app));
      if (defaultBranch === null || pr.headRef === defaultBranch) return [];
      // The runs the pull request started: a run that a push of its branch also uses became a
      // push run, one that serves another branch's push has `alsoRef`, and runs queued after it
      // closed (a reopen, delivered before the close) are not its closed runs.
      const own = and(
        eq(checkRuns.appId, app.id),
        eq(checkRuns.trigger, 'pull_request'),
        eq(checkRuns.prNumber, pr.number),
        eq(checkRuns.ref, pr.headRef),
        isNull(checkRuns.alsoRef),
        lt(checkRuns.createdAt, pr.closedAt),
      );
      const candidates = await deps.db
        .selectDistinct({ commitSha: checkRuns.commitSha })
        .from(checkRuns)
        .where(and(own, eq(checkRuns.status, 'queued')));
      // Another open pull request with the same head still needs them (one branch and two bases,
      // or two branches at one commit): they become its runs, on its head branch, so closing that
      // one or deleting this branch cancels them as its own. When GitHub cannot tell, they stay.
      const kept: string[] = [];
      const handedOver = new Map<string, { number: number; headRef: string }>();
      for (const { commitSha } of candidates) {
        const open = await openPullRequestsWithHead(app, commitSha);
        const [other] = (open ?? [])
          .filter((each) => each.number !== pr.number)
          .sort((a, b) => a.number - b.number);
        if (open === null || other !== undefined) kept.push(commitSha);
        if (other !== undefined) handedOver.set(commitSha, other);
      }
      if (kept.length === candidates.length && handedOver.size === 0) return [];
      const message = `Cancelled: pull request #${pr.number} was ${pr.merged ? 'merged' : 'closed'}`;
      const { cancelled, moved } = await deps.db.transaction(async (tx) => {
        await lockApp(tx, app.id);
        const moved: CheckRunRow[] = [];
        for (const [commitSha, other] of handedOver) {
          moved.push(
            ...(await tx
              .update(checkRuns)
              .set({ prNumber: other.number, ref: other.headRef })
              .where(and(own, eq(checkRuns.status, 'queued'), eq(checkRuns.commitSha, commitSha)))
              .returning()),
          );
        }
        if (kept.length === candidates.length) return { cancelled: [], moved };
        const cancelled = await cancelQueued(
          tx,
          and(own, kept.length === 0 ? undefined : notInArray(checkRuns.commitSha, kept)),
          { reason: 'closed', message, summary: { prNumber: pr.number, merged: pr.merged } },
          actor,
        );
        return { cancelled, moved };
      });
      for (const row of moved) {
        deps.events.publish({
          topic: 'checks',
          action: 'updated',
          resourceId: row.id,
          data: { appId: row.appId },
        });
      }
      for (const row of cancelled) announceStatus(deps, row);
      if (cancelled.length > 0) {
        logger.info(
          { appId: app.id, prNumber: pr.number, merged: pr.merged, cancelled: cancelled.length },
          'queued checks of a closed pull request cancelled',
        );
      }
      return cancelled.map((row) => toCheckRun(row));
    },

    async closeBranch(app, branch, actor) {
      const defaultBranch = branch.defaultBranch ?? (await defaultBranchOf(app));
      if (defaultBranch === null || branch.name === defaultBranch) return [];
      // Only the commit the branch pointed at: a branch created again meanwhile has others.
      const ofBranch = and(
        eq(checkRuns.appId, app.id),
        eq(checkRuns.ref, branch.name),
        eq(checkRuns.commitSha, branch.headSha),
        isNull(checkRuns.alsoRef),
        inArray(checkRuns.trigger, COPYABLE_TRIGGERS),
        eq(checkRuns.status, 'queued'),
      );
      const [queued] = await deps.db
        .select({ id: checkRuns.id })
        .from(checkRuns)
        .where(ofBranch)
        .limit(1);
      if (!queued) return [];
      // An open pull request from another branch at the same commit still needs them: they become
      // its runs. Pull requests from this branch close with it. When GitHub cannot tell, they stay.
      const open = await openPullRequestsWithHead(app, branch.headSha);
      if (open === null) return [];
      const [other] = open
        .filter((each) => each.headRef !== branch.name)
        .sort((a, b) => a.number - b.number);
      const message = `${BRANCH_DELETED_PREFIX}${branch.name} was deleted`;
      const { cancelled, moved } = await deps.db.transaction(async (tx) => {
        await lockApp(tx, app.id);
        if (other) {
          const moved = await tx
            .update(checkRuns)
            .set({ trigger: 'pull_request', prNumber: other.number, ref: other.headRef })
            .where(ofBranch)
            .returning();
          return { cancelled: [], moved };
        }
        const cancelled = await cancelQueued(
          tx,
          ofBranch,
          { reason: 'closed', message, summary: { branch: branch.name } },
          actor,
        );
        return { cancelled, moved: [] as CheckRunRow[] };
      });
      for (const row of moved) {
        deps.events.publish({
          topic: 'checks',
          action: 'updated',
          resourceId: row.id,
          data: { appId: row.appId },
        });
      }
      for (const row of cancelled) announceStatus(deps, row);
      if (cancelled.length > 0 || moved.length > 0) {
        logger.info(
          {
            appId: app.id,
            branch: branch.name,
            cancelled: cancelled.length,
            ...(other ? { handedTo: other.number } : {}),
          },
          other
            ? 'queued checks of a deleted branch handed to an open pull request'
            : 'queued checks of a deleted branch cancelled',
        );
      }
      return cancelled.map((row) => toCheckRun(row));
    },

    async queueScheduled(app, slot, schedule) {
      const actor = systemActor('check-scheduler');
      const connection = await getConnection(deps.db, app.connectionId);
      const provider = providerFor(deps, connection);
      let branch: string;
      let sha: string;
      try {
        branch = await provider.defaultBranch(app.repoOwner, app.repoName);
        sha = (await provider.resolveRef(app.repoOwner, app.repoName, branch)).sha;
      } catch (error) {
        throw toGitProblem(error);
      }
      const treeSha = await treeOf(app, sha);
      const limits = await queueLimits();
      const result = await deps.db.transaction(async (tx) => {
        const locked = await lockApp(tx, app.id);
        const settings = checksSettingsOf(locked);
        // Changed or turned off meanwhile, or this slot queued already (by another pass).
        const last = locked.checksLastSlot;
        if (settings.schedule !== schedule || (last !== null && slot <= last)) return null;
        const busy = await activeNames(tx, app.id, sha);
        const items = settings.items.filter((item) => !busy.has(item.name));
        const full = items.length === 0 ? null : await queueFull(tx, locked, items.length, limits);
        // A full queue: the slot is used, nothing is queued (no errored runs on the branch).
        const note = full ? `Not queued for ${slotLabel(slot)}: ${full}` : null;
        await markSlot(tx, app.id, slot, note);
        if (note) return { rows: [], nodeId: locked.nodeId, note, changed: true };
        const commit = { sha, ref: branch, prNumber: null, trigger: 'schedule' as const, treeSha };
        const summary = { schedule, slot: slot.toISOString() };
        const rows = await insertRuns(tx, locked, settings, items, commit, actor, summary);
        return { rows, nodeId: locked.nodeId, note, changed: locked.checksScheduleNote !== null };
      });
      if (!result) return { kind: 'none' };
      // The note shows in the app's Checks tab.
      if (result.changed) {
        deps.events.publish({ topic: 'apps', action: 'updated', resourceId: app.id });
      }
      if (result.note) {
        logger.warn(
          { appId: app.id, slot: slot.toISOString(), note: result.note },
          'scheduled checks not queued',
        );
        return { kind: 'skipped', note: result.note };
      }
      if (result.rows.length === 0) return { kind: 'none' };
      logger.info(
        {
          appId: app.id,
          commitSha: sha,
          slot: slot.toISOString(),
          checks: result.rows.map((row) => row.name),
        },
        'scheduled checks queued',
      );
      queued(result.rows, result.nodeId);
      return { kind: 'queued', runs: result.rows.map((row) => toCheckRun(row)) };
    },

    async skipScheduled(app, slot, schedule, note) {
      const marked = await deps.db.transaction(async (tx) => {
        const locked = await lockApp(tx, app.id);
        const last = locked.checksLastSlot;
        if (checksSettingsOf(locked).schedule !== schedule || (last !== null && slot <= last)) {
          return false;
        }
        await markSlot(tx, app.id, slot, note);
        return true;
      });
      if (!marked) return;
      deps.events.publish({ topic: 'apps', action: 'updated', resourceId: app.id });
      logger.warn({ appId: app.id, slot: slot.toISOString(), note }, 'scheduled checks not queued');
    },

    async cancel(id, actor) {
      let row = await loadRow(id);
      assertActive(row);
      if (row.status === 'queued') {
        const cancelled = await cancelLocally(row, 'queued', CANCELLED_MESSAGE, actor);
        if (cancelled) return toCheckRun(cancelled);
        // Sent to its node (or finished) meanwhile.
        row = await loadRow(id);
        assertActive(row);
        if (row.status === 'queued') throw conflict('The check run changed meanwhile; try again');
      }
      return cancelRunning(row, actor);
    },

    async rerun(id, actor) {
      const previous = await loadRow(id);
      if (isActiveCheckRunStatus(previous.status)) {
        throw conflict(`The check run is ${previous.status}; only finished runs can run again`);
      }
      const limits = await queueLimits();
      const { row, nodeId } = await deps.db.transaction(async (tx) => {
        const app = await lockApp(tx, previous.appId);
        const settings = checksSettingsOf(app);
        const item = settings.items.find((entry) => entry.name === previous.name);
        if (!item) throw conflict(`The check "${previous.name}" is no longer configured`);
        if ((await activeNames(tx, app.id, previous.commitSha)).has(item.name)) {
          throw conflict(
            `${item.name} already runs for ${shortSha(previous.commitSha)}; cancel it first`,
          );
        }
        const full = await queueFull(tx, app, 1, limits);
        if (full) throw conflict(`Not queued: ${full}; wait for them or raise the limit`);
        const commit = {
          sha: previous.commitSha,
          ref: previous.ref,
          prNumber: previous.prNumber,
          // A scheduled run's re-run reports where it did (launchway/<name>/schedule), never over
          // the verdict of the push on that commit.
          trigger: previous.trigger === 'schedule' ? ('schedule' as const) : ('manual' as const),
          treeSha: previous.treeSha,
        };
        const [created] = await insertRuns(tx, app, settings, [item], commit, actor, {
          rerunOf: previous.id,
        });
        if (!created) throw new Error('insert returned no row');
        return { row: created, nodeId: app.nodeId };
      });
      queued([row], nodeId);
      return toCheckRun(row);
    },

    logStream(id, query, signal) {
      return logStream<CheckRunStatus>(
        {
          hub,
          id,
          follow: query.follow,
          after: query.after,
          history: async (after, limit) => {
            const rows = await deps.db
              .select()
              .from(checkLogLines)
              .where(and(eq(checkLogLines.runId, id), gt(checkLogLines.seq, after)))
              .orderBy(asc(checkLogLines.seq))
              .limit(limit);
            return rows.map((row) => ({
              seq: row.seq,
              timestamp: row.loggedAt.toISOString(),
              stream: row.stream,
              line: row.line,
            }));
          },
          status: async () => (await loadRow(id)).status,
          live: isActiveCheckRunStatus,
        },
        signal,
      );
    },

    async cancelForApp(appId, actor) {
      const cancellation = { reason: 'cancelled', message: APP_DELETED_MESSAGE } as const;
      const cancelled = await deps.db.transaction(async (tx) => {
        await lockApp(tx, appId);
        return cancelQueued(tx, eq(checkRuns.appId, appId), cancellation, actor);
      });
      for (const row of cancelled) announceStatus(deps, row);
      // The agent's `cancelled` result keeps this message if it lands first.
      const running = await deps.db
        .update(checkRuns)
        .set({ statusMessage: APP_DELETED_MESSAGE })
        .where(and(eq(checkRuns.appId, appId), eq(checkRuns.status, 'running')))
        .returning();
      for (const row of running) {
        try {
          await deps.agents.cancelCheck(row.nodeId, row.id);
        } catch (error) {
          logger.info(
            { runId: row.id, nodeId: row.nodeId, reason: messageOf(error) },
            'could not cancel a check run on its node',
          );
        }
        await cancelLocally(row, 'running', APP_DELETED_MESSAGE, actor);
      }
    },

    async pruneLogs(now = new Date()) {
      const cutoff = new Date(now.getTime() - CHECK_LOG_RETENTION_MS);
      let total = 0;
      for (;;) {
        const batch = deps.db
          .select({ id: checkLogLines.id })
          .from(checkLogLines)
          .where(lt(checkLogLines.loggedAt, cutoff))
          .limit(PRUNE_BATCH);
        const deleted = await deps.db
          .delete(checkLogLines)
          .where(inArray(checkLogLines.id, batch))
          .returning({ id: checkLogLines.id });
        total += deleted.length;
        if (deleted.length < PRUNE_BATCH) break;
      }
      if (total > 0) logger.info({ count: total }, 'pruned check log lines');
      return total;
    },
  };
}
