// The automation of Dependabot pull requests (ADR 0023): gathers what GitHub and the checks say,
// asks the pure `decide` what to do, has the one executor do it, and keeps everything in
// `automation_runs` so a redelivery, a restart or the 2-minute reconcile resumes where it stopped.
//
// One pull request has one writer at a time, across service instances and processes: the work
// holds a PostgreSQL advisory lock on (app, kind, key), re-reads the app's settings under it, and
// drops every write the settings no longer allow.
import { createHash } from 'node:crypto';
import {
  type AppAutomationSettings,
  type AppId,
  type AutomationActionRecord,
  type AutomationChange,
  type AutomationRun,
  type AutomationSweep,
  DEFAULT_APP_AUTOMATION_SETTINGS,
  GitRef,
  type UpdateAppAutomation,
} from '@launchway/contracts';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Deps } from '../../deps.js';
import { type RequestActor, systemActor } from '../../lib/auth-context.js';
import { conflict, notFound } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { checksSettingsOf } from '../checks/model.js';
import { checkRuns } from '../checks/schema.js';
import { type CommitTarget, createChecksService, runCountsForCommit } from '../checks/service.js';
import { checkTrigger } from '../checks/trigger.js';
import { type ConnectionRow, findConnection } from '../github/providers.js';
import {
  createAutomationExecutor,
  type ExecutionContext,
  type PerformableAction,
} from './executor.js';
import {
  type AutomationGitHub,
  bareLogin,
  createAutomationGitHub,
  type PullDetail,
} from './github.js';
import type { ActionOutcome, AutomationAction } from './policy/actions.js';
import {
  CLASSIFIER_VERSION,
  type ClassifierPolicy,
  classifyDependabotPullRequest,
  type Verdict,
} from './policy/classify.js';
import {
  type AppNotice,
  type AutoMergeState,
  appNotice,
  type DecideSnapshot,
  decide,
  type MainState,
  type SnapshotCheck,
} from './policy/decide.js';
import { automationRuns } from './schema.js';

type AppRow = typeof apps.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;
type RunKind = RunRow['kind'];

const MAX_ROUNDS = 8;
const RECENT_RUNS = 20;
/** Reconcile looks at most at this many open Dependabot pull requests per app. */
const MAX_PULLS_PER_TICK = 200;
/**
 * An unknown classification (GitHub's lists still incomplete) is retried on every pass for this
 * long after the head was first seen, then final: pushes and edits of one head arrive within
 * seconds of each other, exactly when the lists are most often incomplete.
 */
const CLASSIFY_PATIENCE_MS = 10 * 60_000;
/** Failed attempts at one pull request before one ntfy. */
const FAILURES_BEFORE_NOTICE = 3;
/** Everything a pause or a change away from `on` waits for, at most. */
const SWEEP_BUDGET_MS = 8_000;
const SWEEP_REQUEST_TIMEOUT_MS = 3_000;
const SWEEP_CONCURRENCY = 4;
/** Connections of each dedicated lock pool (handles, sweeps): the main pool is never held idle. */
const LOCK_POOL_SIZE = 4;
/** A handle that runs longer loses its lock and counts as a failure. */
const HANDLE_DEADLINE_MS = 120_000;
/** A held entry for another head than the API reports is moved onto it after this long. */
const HELD_STALE_MS = 5 * 60_000;
/** A classified head without a check run for this long is announced once. */
const NO_CHECKS_NOTICE_MS = 10 * 60_000;

/** The app has no GitHub App connection that can write: the one case that raises "cannot reach GitHub". */
class NoUsableGitHub extends Error {
  override readonly name = 'NoUsableGitHub';
}

/** A disable `decide` asked for failed: the auto-merge may still be on. */
class DisableFailed extends Error {
  override readonly name = 'DisableFailed';
}

/** What a run keeps of the last snapshot (JSON, shown in the UI). */
interface StoredSnapshot extends Record<string, unknown> {
  headSha: string;
  title: string;
  url: string;
  verdict: Verdict | null;
  main: MainState;
  mode: string;
  paused: boolean;
  conflictSince: string | null;
  state: string | null;
  reason: string | null;
  stateSeq: number;
  /** An auto-merge the App enabled is on (until a disable is confirmed). */
  appEnabled: boolean;
  /** What the verdict was reached under: a change of any of them re-classifies. */
  policyHash: string;
  classifierVersion: number;
  baseRef: string;
  draft: boolean;
  /** When this head was first seen. */
  firstSeenAt: string;
}

/** Checks of a head that wait for its classification (kept apart from the rest of the snapshot). */
interface Held {
  sha: string;
  targets: CommitTarget[];
  /** When the first event of this head was recorded. */
  at?: string;
}

export const automationOf = (app: Pick<AppRow, 'automation'>): AppAutomationSettings => ({
  ...DEFAULT_APP_AUTOMATION_SETTINGS,
  ...app.automation,
});

const policyOf = (settings: AppAutomationSettings): ClassifierPolicy => ({
  dependabotUserId: settings.dependabotUserId,
  allowedPaths: settings.allowedPaths,
  holdImages: settings.holdImages,
});

const policyHashOf = (policy: ClassifierPolicy): string =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);

const runKey = (number: number) => `pr-${number}`;
const numberOfKey = (key: string) => Number(key.slice(3));
const message = (error: unknown) => (error instanceof Error ? error.message : 'unknown');

function toApiRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    appId: row.appId,
    kind: row.kind,
    key: row.key,
    state: row.state,
    snapshot: row.snapshot,
    actions: row.actions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Outcomes of the actions that were performed (a notification counts once it is recorded). */
function doneOf(actions: readonly AutomationActionRecord[]): Record<string, ActionOutcome> {
  const done: Record<string, ActionOutcome> = {};
  for (const a of actions) {
    if (a.type === 'notify' && a.status === 'pending') {
      done[a.key] = { status: 'done', detail: 'queued' };
    } else if (a.status === 'done') {
      done[a.key] = { status: 'done' };
    } else if (a.status === 'refused') {
      done[a.key] = {
        status: 'refused',
        reason: String(a.result?.reason ?? 'refused'),
        ...(a.result?.transient === true ? { transient: true } : {}),
      };
    }
  }
  return done;
}

const heldOf = (snapshot: Record<string, unknown> | undefined): Held | null => {
  const held = snapshot?.held as Held | null | undefined;
  return held && typeof held === 'object' && Array.isArray(held.targets) ? held : null;
};

/** The newest run of each check name for a commit. */
async function latestChecks(deps: Deps, appId: AppId, sha: string): Promise<SnapshotCheck[]> {
  const rows = await deps.db
    .select({ id: checkRuns.id, name: checkRuns.name, status: checkRuns.status })
    .from(checkRuns)
    .where(and(eq(checkRuns.appId, appId), eq(checkRuns.commitSha, sha)))
    .orderBy(desc(checkRuns.createdAt), desc(checkRuns.id));
  const seen = new Set<string>();
  const latest: SnapshotCheck[] = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    latest.push({ id: row.id, name: row.name, status: row.status });
  }
  return latest;
}

// --- Shared by every service instance of the process ------------------------------------------

/** A lock must outlive a slow GitHub call: no server or role timeout may drop it. */
export const LOCK_POOL_OPTIONS =
  '-c idle_in_transaction_session_timeout=0 -c idle_session_timeout=0';

/** Session-level advisory locks live on dedicated connections, never on the main pool. */
interface LockPools {
  handles: pg.Pool;
  sweep: pg.Pool;
}
const lockPools = new Map<string, LockPools>();

function lockPoolsFor(deps: Deps): LockPools {
  const url = (deps.db as unknown as { $client: pg.Pool }).$client.options.connectionString ?? '';
  const existing = lockPools.get(url);
  if (existing) return existing;
  const make = () => {
    const pool = new pg.Pool({
      connectionString: url,
      max: LOCK_POOL_SIZE,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 0,
      application_name: 'launchway-locks',
      options: LOCK_POOL_OPTIONS,
      allowExitOnIdle: true,
    });
    pool.on('error', () => undefined);
    return pool;
  };
  const pools = { handles: make(), sweep: make() };
  lockPools.set(url, pools);
  return pools;
}

interface SweepSlot {
  running: Promise<AutomationSweep>;
  queued: Promise<AutomationSweep> | null;
}
const sweepSlots = new Map<string, SweepSlot>();
interface RunSlot {
  next: { app: AppRow; connection: ConnectionRow } | null;
}
const runSlots = new Map<string, RunSlot>();
/** Background work that tests (and shutdown) may wait for. */
const background = new Set<Promise<unknown>>();

function startSweep(appId: string, run: () => Promise<AutomationSweep>): Promise<AutomationSweep> {
  const running: Promise<AutomationSweep> = run().finally(() => {
    if (sweepSlots.get(appId)?.running === running) sweepSlots.delete(appId);
  });
  sweepSlots.set(appId, { running, queued: null });
  return running;
}

/** One sweep per app at a time, and at most one more waiting: a loop of pauses shares them. */
function sweepOnce(appId: string, run: () => Promise<AutomationSweep>): Promise<AutomationSweep> {
  const slot = sweepSlots.get(appId);
  if (!slot) return startSweep(appId, run);
  if (slot.queued !== null) return slot.queued;
  const queued = slot.running
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      sweepSlots.delete(appId);
      return startSweep(appId, run);
    });
  slot.queued = queued;
  return queued;
}

export function createAutomationService(
  deps: Deps,
  options: { handleDeadlineMs?: number; sweepBudgetMs?: number } = {},
) {
  const logger = deps.logger.child({ component: 'automation' });
  const executor = createAutomationExecutor(deps);
  const checks = createChecksService(deps);
  const actor = systemActor('automation');

  const lockPoolsOfDeps = lockPoolsFor(deps);
  const handleDeadlineMs = options.handleDeadlineMs ?? HANDLE_DEADLINE_MS;
  const sweepBudgetMs = options.sweepBudgetMs ?? SWEEP_BUDGET_MS;

  /**
   * Runs `work` while holding the advisory lock of one run, across instances and processes, on a
   * connection of a dedicated pool. `waitMs` null waits for the lock; otherwise it gives up
   * (null) when the lock is not free in time.
   */
  async function lockedRun<T>(
    which: keyof LockPools,
    appId: string,
    kind: RunKind,
    key: string,
    waitMs: number | null,
    work: (lockLost: AbortSignal) => Promise<T>,
  ): Promise<{ value: T } | null> {
    const name = `${appId}:${kind}:${key}`;
    const until = waitMs === null ? Number.POSITIVE_INFINITY : Date.now() + waitMs;
    const client = await lockPoolsOfDeps[which].connect();
    let held = false;
    let broken = false;
    // pg-pool takes its error listener off a client while it is checked out: a lost connection
    // (a restart, a terminated backend) would be an uncaught exception. Losing it loses the lock.
    const lost = new AbortController();
    const lostFor = new Promise<never>((_, reject) => {
      lost.signal.addEventListener('abort', () => reject(lost.signal.reason), { once: true });
    });
    lostFor.catch(() => undefined);
    const onError = (error: Error) => {
      broken = true;
      lost.abort(new Error(`the lock connection failed: ${error.message}`));
    };
    client.on('error', onError);
    try {
      for (;;) {
        const res = await Promise.race([
          client.query<{ locked: boolean }>(
            'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
            [name],
          ),
          lostFor,
        ]);
        if (res.rows[0]?.locked === true) break;
        if (Date.now() >= until) return null;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      held = true;
      const running = work(lost.signal);
      running.catch(() => undefined);
      return { value: await Promise.race([running, lostFor]) };
    } finally {
      if (held && !broken) {
        try {
          await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [name]);
        } catch {
          broken = true;
        }
      }
      client.off('error', onError);
      if (broken) client.on('error', () => undefined);
      client.release(broken);
    }
  }

  async function withLock<T>(
    appId: string,
    kind: RunKind,
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return ((await lockedRun('handles', appId, kind, key, null, work)) as { value: T }).value;
  }

  async function repositoryAutomated(owner: string, name: string): Promise<boolean> {
    const rows = await deps.db
      .select({ id: apps.id })
      .from(apps)
      .where(
        and(
          sql`lower(${apps.repoOwner}) = ${owner.toLowerCase()}`,
          sql`lower(${apps.repoName}) = ${name.toLowerCase()}`,
          sql`(${apps.automation}->>'merge' <> 'off' OR ${apps.automation}->>'train' <> 'off')`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  type Reader = Pick<Deps['db'], 'select'>;

  /** The names among `names` that another app of the same repository runs as checks. */
  async function siblingCheckNames(
    db: Reader,
    app: AppRow,
    names: readonly string[],
  ): Promise<string[]> {
    if (names.length === 0) return [];
    const siblings = await db
      .select()
      .from(apps)
      .where(
        and(
          ne(apps.id, app.id),
          sql`lower(${apps.repoOwner}) = ${app.repoOwner.toLowerCase()}`,
          sql`lower(${apps.repoName}) = ${app.repoName.toLowerCase()}`,
        ),
      );
    const clash = new Set<string>();
    for (const sibling of siblings) {
      const checksOfSibling = checksSettingsOf(sibling);
      if (!checksOfSibling.enabled) continue;
      for (const item of checksOfSibling.items) if (names.includes(item.name)) clash.add(item.name);
    }
    return [...clash].sort();
  }

  const readApp = async (appId: string): Promise<AppRow | undefined> =>
    (
      await deps.db
        .select()
        .from(apps)
        .where(eq(apps.id, appId as AppId))
    )[0];

  const loadRun = async (appId: AppId, key: string, kind: RunKind = 'pr') =>
    (
      await deps.db
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.appId, appId),
            eq(automationRuns.kind, kind),
            eq(automationRuns.key, key),
          ),
        )
    )[0];

  /** The held checks and the failure count of a run survive a save of the rest of its snapshot. */
  async function saveRun(
    appId: AppId,
    key: string,
    state: string,
    snapshot: StoredSnapshot,
    actions: AutomationActionRecord[],
  ): Promise<void> {
    const merged = sql`${JSON.stringify(snapshot)}::jsonb || jsonb_build_object(
      'held', coalesce(${automationRuns.snapshot}->'held', 'null'::jsonb),
      'failures', coalesce(${automationRuns.snapshot}->'failures', '0'::jsonb),
      'noticeSeq', coalesce(${automationRuns.snapshot}->'noticeSeq', '0'::jsonb))`;
    await deps.db
      .insert(automationRuns)
      .values({ appId, kind: 'pr', key, state, snapshot, actions })
      .onConflictDoUpdate({
        target: [automationRuns.appId, automationRuns.kind, automationRuns.key],
        set: { state, snapshot: merged as never, actions, updatedAt: new Date() },
      });
  }

  const requiredChecksOf = (app: AppRow): string[] =>
    checksSettingsOf(app).items.map((item) => item.name);

  /**
   * Until the release train evaluates the ruleset's required contexts, main is `green` only when
   * every configured check has succeeded on the default branch's head.
   */
  async function mainState(
    app: AppRow,
    github: AutomationGitHub,
  ): Promise<{ state: MainState; sha: string | null }> {
    let sha: string | null = null;
    try {
      sha = (await github.defaultBranchHead()).sha;
      const names = requiredChecksOf(app);
      if (names.length === 0) return { state: 'unknown', sha };
      const latest = await latestChecks(deps, app.id, sha);
      const statuses = names.map((name) => latest.find((check) => check.name === name)?.status);
      if (statuses.includes('failed')) return { state: 'red', sha };
      if (statuses.every((status) => status === 'succeeded')) return { state: 'green', sha };
      if (statuses.some((status) => status === 'errored' || status === 'cancelled')) {
        return { state: 'unknown', sha };
      }
      return { state: 'pending', sha };
    } catch (error) {
      logger.warn(
        { appId: app.id, reason: message(error) },
        'the state of the default branch is unknown',
      );
      return { state: 'unknown', sha };
    }
  }

  // --- Notices (one per key, claimed by the insert) and notifications ---------------------------

  /** Sends the notifications a run recorded; claims them under the run's lock, so none is sent twice. */
  async function flushRun(appId: AppId, kind: RunKind, key: string): Promise<void> {
    const claimed = await withLock(appId, kind, key, async () => {
      const row = await loadRun(appId, key, kind);
      if (!row) return [];
      const pending = row.actions.filter((a) => a.type === 'notify' && a.status === 'pending');
      if (pending.length === 0) return [];
      for (const a of pending) {
        a.status = 'done';
        a.result = { status: 'done', detail: 'sending' };
      }
      await deps.db
        .update(automationRuns)
        .set({ actions: row.actions })
        .where(eq(automationRuns.id, row.id));
      return pending.map((a) => ({ ...a }) as AutomationActionRecord);
    });
    for (const a of claimed) {
      const result = await executor.deliver(
        a as unknown as Extract<AutomationAction, { type: 'notify' }>,
      );
      await withLock(appId, kind, key, async () => {
        const row = await loadRun(appId, key, kind);
        const target = row?.actions.find((x) => x.key === a.key);
        if (!row || !target) return;
        target.result = {
          status: 'done',
          detail: result.delivered ? 'delivered' : `not delivered: ${result.reason}`,
        };
        await deps.db
          .update(automationRuns)
          .set({ actions: row.actions })
          .where(eq(automationRuns.id, row.id));
      });
    }
  }

  const logFlush = (appId: AppId, error: unknown) =>
    logger.warn({ appId, reason: message(error) }, 'sending notifications failed');

  async function flushPending(): Promise<void> {
    const rows = await deps.db
      .select({
        appId: automationRuns.appId,
        kind: automationRuns.kind,
        key: automationRuns.key,
      })
      .from(automationRuns)
      .where(sql`${automationRuns.actions} @> '[{"type":"notify","status":"pending"}]'::jsonb`);
    for (const row of rows) {
      await flushRun(row.appId, row.kind, row.key).catch((error: unknown) =>
        logFlush(row.appId, error),
      );
    }
  }

  /** Sends later, without making the caller wait. */
  function flushLater(appId: AppId, key: string, kind: RunKind = 'pr'): void {
    void flushRun(appId, kind, key).catch((error: unknown) => logFlush(appId, error));
  }

  /** An app-level notification, once per notice key: the first insert wins. */
  async function emitNotice(appId: AppId, notice: AppNotice): Promise<void> {
    const action = appNotice(notice);
    const key = `notice:${action.key}`;
    const inserted = await deps.db
      .insert(automationRuns)
      .values({
        appId,
        kind: 'notice',
        key,
        state: 'notice',
        snapshot: {},
        actions: [
          {
            type: 'notify',
            key: action.key,
            input: action.input,
            status: 'pending',
            result: null,
          },
        ],
      })
      .onConflictDoNothing()
      .returning({ id: automationRuns.id });
    if (inserted.length > 0) flushLater(appId, key, 'notice');
  }

  // --- Held checks: the checks of a head wait until the head is classified ----------------------

  async function hold(
    appId: AppId,
    number: number,
    sha: string,
    target: CommitTarget,
  ): Promise<void> {
    const key = runKey(number);
    await deps.db.transaction(async (tx) => {
      await tx
        .insert(automationRuns)
        .values({ appId, kind: 'pr', key, state: 'new', snapshot: {}, actions: [] })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.appId, appId),
            eq(automationRuns.kind, 'pr'),
            eq(automationRuns.key, key),
          ),
        )
        .for('update');
      const held = heldOf(row?.snapshot);
      const next: Held =
        held && held.sha === sha
          ? {
              sha,
              ...(held.at === undefined ? {} : { at: held.at }),
              targets: held.targets.some(
                (t) => t.trigger === target.trigger && t.ref === target.ref,
              )
                ? held.targets
                : [...held.targets, target],
            }
          : { sha, at: new Date().toISOString(), targets: [target] };
      await tx
        .update(automationRuns)
        .set({
          snapshot:
            sql`jsonb_set(${automationRuns.snapshot}, '{held}', ${JSON.stringify(next)}::jsonb)` as never,
        })
        .where(eq(automationRuns.id, row?.id as RunRow['id']));
    });
  }

  async function clearHeld(runId: RunRow['id'], held: Held): Promise<void> {
    await deps.db
      .update(automationRuns)
      .set({ snapshot: sql`${automationRuns.snapshot} - 'held'` as never })
      .where(
        and(
          eq(automationRuns.id, runId),
          sql`${automationRuns.snapshot}->'held' = ${JSON.stringify(held)}::jsonb`,
        ),
      );
  }

  /**
   * Whether every configured check has a run on the head that counts (the queue's own predicate,
   * and a run a person cancelled does not): a head without one is queued again.
   */
  async function hasChecks(app: AppRow, sha: string): Promise<boolean> {
    const rows = await deps.db
      .selectDistinct({ name: checkRuns.name })
      .from(checkRuns)
      .where(
        and(
          eq(checkRuns.appId, app.id),
          eq(checkRuns.commitSha, sha),
          runCountsForCommit({ requeueCancelled: true }),
        ),
      );
    const have = new Set(rows.map((row) => row.name));
    const wanted = requiredChecksOf(app);
    return wanted.length === 0 ? rows.length > 0 : wanted.every((name) => have.has(name));
  }

  /**
   * Queues the checks of a head once it is classified: the held ones (moved onto the head the API
   * reports when they are older than it and stale), or, for a head without any, the checks the
   * event would have queued. Held checks stay while the queue refuses them. Called under the run's
   * lock; throws when queueing fails (the next pass tries again, and the queue dedupes per
   * commit). `pull` null: the app's automation is off, the held checks are released as they are.
   */
  async function releaseChecks(
    appId: AppId,
    number: number,
    pull: PullDetail | null,
    classified: boolean,
    seen: { firstSeenAt: string; mode: AppAutomationSettings['merge'] } | null,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const row = await loadRun(appId, runKey(number));
    const held = heldOf(row?.snapshot);
    const drop = async () => {
      signal.throwIfAborted();
      if (row && held) await clearHeld(row.id, held);
    };
    if (pull && !pull.open) return drop();
    if (pull && !classified) return;
    const app = await readApp(appId);
    if (!app || !checksSettingsOf(app).enabled) return drop();
    let targets: CommitTarget[] = [];
    if (held && (!pull || held.sha === pull.headSha)) {
      targets = held.targets;
    } else if (held && pull) {
      // Held for another head than the API reports: a fresh entry waits for the API to catch up,
      // a stale one is for a head whose events were missed, and moves onto the head.
      if (Date.now() - Date.parse(held.at ?? '') < HELD_STALE_MS) return;
      targets = held.targets.map(({ treeSha: _tree, ...target }) => ({
        ...target,
        sha: pull.headSha,
      }));
    } else if (pull && !(await hasChecks(app, pull.headSha))) {
      const ref = GitRef.safeParse(pull.headRef);
      const decision = checkTrigger(checksSettingsOf(app), {
        kind: 'pull_request',
        baseBranch: pull.classifier.baseRef,
        author: { login: pull.authorLogin, type: pull.classifier.authorType },
      });
      if (ref.success && decision.run) {
        targets = [
          { sha: pull.headSha, ref: ref.data, prNumber: pull.number, trigger: 'pull_request' },
        ];
      }
    }
    let full = false;
    for (const target of targets) {
      signal.throwIfAborted();
      const runs = await checks.queueForCommit(app, target, actor, {
        requeueCancelled: true,
        signal,
      });
      if (runs.some((run) => run.reason === 'queue-full')) full = true;
    }
    // A queue that refused the runs keeps the entry: the next pass releases it again.
    if (!full) await drop();
    if (
      pull &&
      seen &&
      targets.length > 0 &&
      Date.now() - Date.parse(seen.firstSeenAt) >= NO_CHECKS_NOTICE_MS &&
      !(await hasChecks(app, pull.headSha))
    ) {
      signal.throwIfAborted();
      await emitNotice(appId, {
        kind: 'no-checks',
        mode: seen.mode,
        number,
        headSha: pull.headSha,
        url: pull.url,
      });
    }
  }

  // --- One pull request -------------------------------------------------------------------------

  interface Handling {
    readonly app: AppRow;
    readonly connection: ConnectionRow;
    readonly number: number;
    readonly main: MainState;
    /** How long to wait for the lock of the pull request; null: as long as it takes. */
    readonly waitMs: number | null;
  }

  /**
   * One pull request: disable what the App enabled on a head not classified yet, classify the head
   * and record it, then perform what `decide` asks, again and again until it asks for nothing,
   * and finally release the checks held for the head. Throws when GitHub or the database fails;
   * what was done is in the run, so a retry resumes. `busy`: another writer has the pull request
   * and the lock did not come free in time. The work has a deadline: past it the lock is released
   * and no further GitHub call or write of this handle goes through.
   */
  async function handle({
    app: appRow,
    connection,
    number,
    main,
    waitMs,
  }: Handling): Promise<'done' | 'busy'> {
    const appId = appRow.id;
    const key = runKey(number);
    const locked = await lockedRun('handles', appId, 'pr', key, waitMs, async (lockLost) => {
      const abort = new AbortController();
      // The lock is gone with its connection: the work stops at once.
      lockLost.addEventListener('abort', () => abort.abort(lockLost.reason), { once: true });
      const timer = setTimeout(
        () => abort.abort(new Error('the automation ran past its deadline for the pull request')),
        handleDeadlineMs,
      );
      const expired = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
      });
      const work = handleLocked(appRow, connection, number, main, abort.signal);
      work.catch(() => undefined);
      try {
        await Promise.race([work, expired]);
      } finally {
        clearTimeout(timer);
      }
    });
    return locked === null ? 'busy' : 'done';
  }

  async function handleLocked(
    appRow: AppRow,
    connection: ConnectionRow,
    number: number,
    main: MainState,
    signal: AbortSignal,
  ): Promise<void> {
    const appId = appRow.id;
    const key = runKey(number);
    {
      const github = openGitHub(appRow, connection, { signal });
      const app = await readApp(appId);
      if (!app) return;
      let settings = automationOf(app);
      const row = await loadRun(appId, key);
      const stored = row?.snapshot as Partial<StoredSnapshot> | undefined;
      const recordedEnable = stored?.appEnabled === true;
      if (settings.merge === 'off' && !recordedEnable) {
        await releaseChecks(appId, number, null, true, null, signal);
        return;
      }
      // Fetched under the lock: it is the head the decisions below are about.
      const pull = await github.pull(number);
      if (!pull.headRef.startsWith('dependabot/')) return;
      const sameHead = stored?.headSha === pull.headSha;
      const now = new Date().toISOString();
      const policy = policyOf(settings);
      const policyHash = policyHashOf(policy);
      const storedVerdict = stored?.verdict ?? null;
      const verdictHolds =
        sameHead &&
        storedVerdict !== null &&
        storedVerdict.verdict !== 'unknown' &&
        stored?.policyHash === policyHash &&
        stored?.classifierVersion === CLASSIFIER_VERSION &&
        stored?.baseRef === pull.classifier.baseRef &&
        stored?.draft === pull.classifier.draft;
      const firstSeenAt = (sameHead ? stored?.firstSeenAt : undefined) ?? now;
      // A new head starts clean, except for notifications of the old one that were not sent yet.
      const actions: AutomationActionRecord[] = (row?.actions ?? []).filter(
        (a) => sameHead || (a.type === 'notify' && a.status === 'pending'),
      );
      const done = doneOf(actions);
      let pullState: PullDetail = pull;
      const isApp = (login: string): boolean => bareLogin(login) === bareLogin(github.appBotLogin);
      // `viaGraphql`: a request with no `enabledBy` is, while an App enable is on record, the App's
      // (GitHub clears the user of a request when the account is gone); it is disabled, not left.
      const authority = (login: string | null, viaGraphql = false): AutoMergeState =>
        login === null
          ? 'none'
          : isApp(login) || (viaGraphql && login === '' && recordedEnable)
            ? 'app'
            : 'other';
      let githubAuto: AutoMergeState;
      if (pull.autoMergeBy !== null) {
        githubAuto = authority(pull.autoMergeBy);
      } else if (!recordedEnable || !pull.open) {
        githubAuto = 'none';
      } else if (!sameHead) {
        // The REST field can lag behind the record: while the record says the App enabled an
        // auto-merge, it is on until a disable is confirmed.
        githubAuto = 'app';
      } else {
        // The same head: GraphQL, which does not lag, settles what REST reads as off.
        githubAuto = authority(await github.autoMergeBy(pull), true);
      }
      const ms = pull.mergeableState;
      const snapshot: DecideSnapshot = {
        now,
        mode: settings.merge,
        paused: settings.paused,
        main,
        requiredChecks: requiredChecksOf(app),
        pull: {
          number,
          url: pull.url,
          headSha: pull.headSha,
          open: pull.open,
          merged: pull.merged,
          autoMerge: githubAuto,
          // Only a definite answer resets the timer: GitHub reports null while it recomputes.
          conflictSince:
            ms === 'dirty'
              ? (stored?.conflictSince ?? now)
              : ms === null || ms === 'unknown'
                ? (stored?.conflictSince ?? null)
                : null,
        },
        verdict: verdictHolds ? storedVerdict : null,
        recorded: {
          state: sameHead ? (stored?.state ?? null) : null,
          reason: sameHead ? (stored?.reason ?? null) : null,
          stateSeq: sameHead ? (stored?.stateSeq ?? 0) : 0,
        },
        checks: await latestChecks(deps, appId, pull.headSha),
        done,
      };
      let lastVerdict: Verdict | null = verdictHolds ? storedVerdict : null;
      const ctx = (): ExecutionContext => ({ appId, github, pull: pullState });

      const persist = () => {
        signal.throwIfAborted();
        return saveRun(
          appId,
          key,
          snapshot.recorded.state ?? 'new',
          {
            headSha: pull.headSha,
            title: pull.title,
            url: pull.url,
            verdict: snapshot.verdict ?? lastVerdict,
            main: snapshot.main,
            mode: snapshot.mode,
            paused: snapshot.paused,
            conflictSince: snapshot.pull.conflictSince,
            state: snapshot.recorded.state,
            reason: snapshot.recorded.reason,
            stateSeq: snapshot.recorded.stateSeq,
            appEnabled: snapshot.pull.autoMerge === 'app',
            policyHash,
            classifierVersion: CLASSIFIER_VERSION,
            baseRef: pull.classifier.baseRef,
            draft: pull.classifier.draft,
            firstSeenAt,
          },
          actions,
        );
      };

      /** The settings as they are now: a write the settings no longer allow is dropped. */
      const writeAllowed = async (): Promise<boolean> => {
        const live = await readApp(appId);
        if (!live) return false;
        settings = automationOf(live);
        snapshot.mode = settings.merge;
        snapshot.paused = settings.paused;
        return settings.merge === 'on' && !settings.paused;
      };

      type Performed = 'done' | 'dropped' | 'transient';
      const perform = async (action: AutomationAction): Promise<Performed> => {
        signal.throwIfAborted();
        const writes =
          action.type === 'github.enableAutoMerge' ||
          action.type === 'github.merge' ||
          action.type === 'checks.rerun';
        if (writes && !(await writeAllowed())) return 'dropped';
        const prior = actions.findIndex((a) => a.key === action.key);
        if (prior >= 0) actions.splice(prior, 1);
        const record: AutomationActionRecord = {
          type: action.type,
          key: action.key,
          input: action.input,
          status: 'pending',
          result: null,
        };
        actions.push(record);
        let transient = false;
        switch (action.type) {
          case 'notify':
            // Recorded now, sent afterwards: a notification can take longer than a webhook may.
            done[action.key] = { status: 'done', detail: 'queued' };
            break;
          case 'recordState':
            snapshot.recorded = {
              state: action.input.state,
              reason: action.input.reason,
              stateSeq: snapshot.recorded.stateSeq + 1,
            };
            record.status = 'done';
            record.result = { status: 'done' };
            done[action.key] = { status: 'done' };
            break;
          default: {
            let outcome: ActionOutcome;
            const autoBefore = snapshot.pull.autoMerge;
            if (action.type === 'github.enableAutoMerge') {
              // The intent is recorded before the request goes out: a response lost to a timeout
              // or the deadline leaves an enable GitHub may have applied, and it must count as on
              // (a pause then sends the disable, whatever REST reads).
              snapshot.pull = { ...snapshot.pull, autoMerge: 'app' };
              await persist();
            }
            try {
              outcome = await executor.perform(action as PerformableAction, ctx());
            } catch (error) {
              actions.pop();
              await persist();
              throw action.type === 'github.disableAutoMerge'
                ? new DisableFailed(message(error), { cause: error })
                : error;
            }
            record.status = outcome.status;
            record.result = { ...outcome };
            done[action.key] = outcome;
            transient = outcome.status === 'refused' && outcome.transient === true;
            if (action.type === 'github.enableAutoMerge') {
              // GitHub's refusal is an answer: no request exists, the intent is withdrawn.
              if (outcome.status !== 'done') {
                snapshot.pull = { ...snapshot.pull, autoMerge: autoBefore };
              }
            } else if (action.type === 'github.disableAutoMerge') {
              // Only a confirmed disable: a refused one threw above.
              snapshot.pull = { ...snapshot.pull, autoMerge: 'none' };
            } else if (action.type === 'checks.rerun' && outcome.status === 'done') {
              // Waiting for the new run: not an errored check this pass.
              snapshot.checks = snapshot.checks.map((check) =>
                check.id === action.input.checkRunId ? { ...check, status: 'queued' } : check,
              );
            } else if (action.type === 'github.merge' && outcome.status === 'done') {
              snapshot.pull = { ...snapshot.pull, open: false, merged: true };
              pullState = { ...pullState, open: false, merged: true };
            }
          }
        }
        await persist();
        return transient ? 'transient' : 'done';
      };

      let classified = false;
      // After a transient refusal the pass only records and announces; the write comes back on
      // the next pass.
      let throttled = false;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        // The settings as they are now: a pause that committed while a write was in flight takes
        // effect in the next round, which then withdraws what that write enabled.
        await writeAllowed();
        const todo = decide(snapshot).filter(
          (a) =>
            !throttled ||
            a.type === 'notify' ||
            a.type === 'recordState' ||
            a.type === 'github.disableAutoMerge',
        );
        let dropped = false;
        for (const action of todo) {
          const result = await perform(action);
          if (result === 'transient') throttled = true;
          if (result === 'dropped') dropped = true;
        }
        if (dropped) {
          // The settings changed under us: decide again with them (it asks for no write now).
          if (round === MAX_ROUNDS - 1) break;
          continue;
        }
        if (snapshot.verdict === null && snapshot.pull.open && !classified) {
          // Disabled first, classified second, recorded third: no check can see an unclassified head.
          classified = true;
          let verdict = classifyDependabotPullRequest(await github.classifierInput(pull, policy));
          if (
            verdict.verdict === 'unknown' &&
            Date.now() - Date.parse(firstSeenAt) >= CLASSIFY_PATIENCE_MS
          ) {
            verdict = { verdict: 'ineligible', reason: verdict.reason };
          }
          snapshot.verdict = verdict;
          lastVerdict = verdict;
          await persist();
        } else if (todo.length === 0) {
          break;
        }
      }
      await persist();
      const known = snapshot.verdict !== null && snapshot.verdict.verdict !== 'unknown';
      await releaseChecks(
        appId,
        number,
        pullState,
        known || !snapshot.pull.open,
        {
          firstSeenAt,
          mode: settings.merge,
        },
        signal,
      );
    }
  }

  /**
   * Counts a failed attempt; the third one of a streak sends a notice, keyed by the head the run
   * knows and the number of the streak, so a later streak is announced again.
   */
  async function noteFailure(app: AppRow, number: number): Promise<void> {
    const key = runKey(number);
    const [row] = await deps.db
      .insert(automationRuns)
      .values({
        appId: app.id,
        kind: 'pr',
        key,
        state: 'new',
        snapshot: { failures: 1 },
        actions: [],
      })
      .onConflictDoUpdate({
        target: [automationRuns.appId, automationRuns.kind, automationRuns.key],
        set: {
          snapshot: sql`jsonb_set(${automationRuns.snapshot}, '{failures}',
            to_jsonb(coalesce((${automationRuns.snapshot}->>'failures')::int, 0) + 1))` as never,
        },
      })
      .returning({ snapshot: automationRuns.snapshot, id: automationRuns.id });
    const snapshot = row?.snapshot as { failures?: unknown; headSha?: unknown } | undefined;
    if (Number(snapshot?.failures ?? 0) !== FAILURES_BEFORE_NOTICE || !row) return;
    const [numbered] = await deps.db
      .update(automationRuns)
      .set({
        snapshot: sql`jsonb_set(${automationRuns.snapshot}, '{noticeSeq}',
          to_jsonb(coalesce((${automationRuns.snapshot}->>'noticeSeq')::int, 0) + 1))` as never,
      })
      .where(eq(automationRuns.id, row.id))
      .returning({ snapshot: automationRuns.snapshot });
    const streak = Number(
      (numbered?.snapshot as { noticeSeq?: unknown } | undefined)?.noticeSeq ?? 1,
    );
    const head = typeof snapshot?.headSha === 'string' ? snapshot.headSha : `pr-${number}`;
    await emitNotice(app.id, {
      kind: 'handle-failed',
      mode: automationOf(app).merge,
      number,
      headSha: `${head}:${streak}`,
      url: null,
    });
  }

  async function clearFailures(appId: AppId, number: number): Promise<void> {
    await deps.db
      .update(automationRuns)
      .set({
        snapshot: sql`jsonb_set(${automationRuns.snapshot}, '{failures}', '0'::jsonb)` as never,
      })
      .where(
        and(
          eq(automationRuns.appId, appId),
          eq(automationRuns.kind, 'pr'),
          eq(automationRuns.key, runKey(number)),
          sql`coalesce((${automationRuns.snapshot}->>'failures')::int, 0) <> 0`,
        ),
      );
  }

  async function connectionOf(app: AppRow): Promise<ConnectionRow> {
    const connection = await findConnection(deps.db, app.connectionId);
    if (!connection) throw new NoUsableGitHub('GitHub connection not found');
    return connection;
  }

  function openGitHub(
    app: AppRow,
    connection: ConnectionRow,
    options?: { requestTimeoutMs?: number; signal?: AbortSignal },
  ): AutomationGitHub {
    try {
      return createAutomationGitHub(deps, app, connection, options);
    } catch (error) {
      throw new NoUsableGitHub(message(error));
    }
  }

  /** Whether a pull request (any, with `number` null) has an auto-merge the App enabled on record. */
  async function hasRecordedEnable(app: AppRow, number: number | null): Promise<boolean> {
    const rows = await deps.db
      .select({ key: automationRuns.key })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.appId, app.id),
          eq(automationRuns.kind, 'pr'),
          sql`${automationRuns.snapshot}->>'appEnabled' = 'true'`,
          ...(number === null ? [] : [eq(automationRuns.key, runKey(number))]),
        ),
      );
    return rows.length > 0;
  }

  /** Whether the app's automation has anything to do for a pull request (off apps: only a leftover). */
  async function isActive(app: AppRow, number: number | null): Promise<boolean> {
    return automationOf(app).merge !== 'off' || hasRecordedEnable(app, number);
  }

  /**
   * Whether the checks of a head wait for its classification: only where an auto-merge could
   * depend on them (the mode is `on`, or the App enabled one for this pull request). In `shadow`
   * a fault of the automation must not withhold checks other things rely on.
   */
  async function holdsChecks(app: AppRow, number: number): Promise<boolean> {
    return automationOf(app).merge === 'on' || (await hasRecordedEnable(app, number));
  }

  async function observeMain(app: AppRow, main: { state: MainState; sha: string | null }) {
    const mode = automationOf(app).merge;
    if (main.state === 'unknown' && mode !== 'off') {
      await emitNotice(app.id, {
        kind: 'main-unknown',
        mode,
        mainSha: main.sha,
        hour: new Date().toISOString().slice(0, 13),
      });
    }
  }

  /** One attempt for one pull request; failures are counted and announced, not thrown. */
  async function attempt(app: AppRow, connection: ConnectionRow, number: number): Promise<void> {
    try {
      const github = openGitHub(app, connection);
      const main = await mainState(app, github);
      await observeMain(app, main);
      await handle({ app, connection, number, main: main.state, waitMs: null });
      await clearFailures(app.id, number);
    } catch (error) {
      logger.warn(
        { appId: app.id, pull: number, reason: message(error) },
        'the automation failed for a pull request; the reconcile retries',
      );
      if (error instanceof NoUsableGitHub) {
        await emitNotice(app.id, {
          kind: 'no-github',
          mode: automationOf(app).merge,
          day: new Date().toISOString().slice(0, 10),
        }).catch(() => undefined);
      }
      if (error instanceof DisableFailed) {
        await emitNotice(app.id, {
          kind: 'stuck-enabled',
          numbers: [number],
          hour: new Date().toISOString().slice(0, 13),
        }).catch(() => undefined);
      }
      await noteFailure(app, number).catch(() => undefined);
    } finally {
      flushLater(app.id, runKey(number));
    }
  }

  /**
   * The attempt for one pull request, in the background: at most one running and one waiting per
   * pull request (a burst of events for it is one more pass, not a pile of handles).
   */
  function runLater(app: AppRow, connection: ConnectionRow, number: number): void {
    const slotKey = `${app.id}:${number}`;
    const slot = runSlots.get(slotKey);
    if (slot) {
      slot.next = { app, connection };
      return;
    }
    const fresh: RunSlot = { next: null };
    runSlots.set(slotKey, fresh);
    const task = (async () => {
      try {
        await attempt(app, connection, number);
        for (let next = fresh.next; next !== null; next = fresh.next) {
          fresh.next = null;
          await attempt(next.app, next.connection, number);
        }
      } finally {
        runSlots.delete(slotKey);
      }
    })();
    background.add(task);
    void task.finally(() => background.delete(task));
  }

  // --- Withdrawing auto-merges: pause and every change away from `on` ---------------------------

  /**
   * Disables every auto-merge the App enabled for the app. The whole sweep, its listing and token
   * mints included, is bounded by one budget; what could not be reached in time is reported as
   * failed (the reconcile keeps trying). Candidates are the recorded pull requests, then the
   * listed ones whose auto-merge the App's bot enabled.
   */
  function sweep(appId: AppId): Promise<AutomationSweep> {
    return sweepOnce(appId, async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('sweep budget spent')), sweepBudgetMs);
      const deadline = Date.now() + sweepBudgetMs;
      const confirmed = new Set<number>();
      const failed = new Set<number>();
      let recorded: number[] = [];
      const expired = new Promise<void>((resolve) => {
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const work = (async () => {
        const runs = await deps.db
          .select({ key: automationRuns.key, snapshot: automationRuns.snapshot })
          .from(automationRuns)
          .where(and(eq(automationRuns.appId, appId), eq(automationRuns.kind, 'pr')));
        recorded = runs
          .filter((r) => (r.snapshot as { appEnabled?: unknown }).appEnabled === true)
          .map((r) => numberOfKey(r.key));
        const app = await readApp(appId);
        if (!app) return;
        const github = openGitHub(app, await connectionOf(app), {
          requestTimeoutMs: SWEEP_REQUEST_TIMEOUT_MS,
          signal: abort.signal,
        });
        const one = async (number: number): Promise<void> => {
          const left = deadline - Date.now();
          try {
            const outcome =
              left > 0
                ? await lockedRun('sweep', appId, 'pr', runKey(number), left, () =>
                    disableOne(appId, github, number, recorded.includes(number)),
                  )
                : null;
            if (outcome === null) failed.add(number);
            else if (outcome.value) confirmed.add(number);
          } catch (error) {
            logger.warn({ appId, pull: number, reason: message(error) }, 'a disable failed');
            failed.add(number);
          }
        };
        const drain = async (numbers: number[]) => {
          const queue = [...numbers];
          await Promise.all(
            Array.from({ length: SWEEP_CONCURRENCY }, async () => {
              for (let n = queue.shift(); n !== undefined; n = queue.shift()) await one(n);
            }),
          );
        };
        await drain(recorded);
        let listed: number[] = [];
        try {
          listed = (await github.openDependabotPulls())
            .filter(
              (pull) =>
                pull.autoMergeBy !== null &&
                bareLogin(pull.autoMergeBy) === bareLogin(github.appBotLogin),
            )
            .map((pull) => pull.number)
            .filter((number) => !recorded.includes(number));
        } catch {
          // The recorded ones were tried; the reconcile finds the rest.
        }
        await drain(listed);
      })();
      work.catch((error: unknown) => {
        logger.warn({ appId, reason: message(error) }, 'the sweep stopped');
      });
      try {
        await Promise.race([work, expired]);
      } finally {
        clearTimeout(timer);
      }
      for (const number of recorded) if (!confirmed.has(number)) failed.add(number);
      return {
        confirmed: [...confirmed].sort((a, b) => a - b),
        failed: [...failed].filter((n) => !confirmed.has(n)).sort((a, b) => a - b),
      };
    });
  }

  /** Under the pull request's lock: disables the App's auto-merge. True when it was on or recorded. */
  async function disableOne(
    appId: AppId,
    github: AutomationGitHub,
    number: number,
    recorded: boolean,
  ): Promise<boolean> {
    const pull = await github.pull(number);
    if (!pull.open || !pull.headRef.startsWith('dependabot/')) return false;
    const enabled =
      pull.autoMergeBy !== null && bareLogin(pull.autoMergeBy) === bareLogin(github.appBotLogin);
    if (!enabled && !recorded) return false;
    // Whenever the record says the App enabled it, REST reading "off" proves nothing (it can
    // lag): the disable goes out, and only a confirmed one (GraphQL shows no request) counts.
    await executor.perform(
      {
        type: 'github.disableAutoMerge',
        key: `sweep:${number}`,
        input: { pullNumber: number },
      },
      { appId, github, pull },
    );
    const key = runKey(number);
    const row = await loadRun(appId, key);
    if (row) {
      const actions = [
        ...row.actions,
        {
          type: 'github.disableAutoMerge',
          key: `sweep:${number}:${Date.now()}`,
          input: { pullNumber: number },
          status: 'done' as const,
          result: { status: 'done' },
        },
      ];
      await deps.db
        .update(automationRuns)
        .set({
          actions,
          snapshot:
            sql`jsonb_set(${automationRuns.snapshot}, '{appEnabled}', 'false'::jsonb)` as never,
        })
        .where(eq(automationRuns.id, row.id));
    }
    return true;
  }

  // --- Reconcile --------------------------------------------------------------------------------

  /**
   * Every 2 minutes: open Dependabot pull requests are handled again (new heads classified; their
   * held checks queued; auto-merge off while the default branch is red or the app is not on;
   * errored checks re-run; failures and long conflicts reported), and notifications that were not
   * sent yet go out. Apps whose automation is off are visited only while something of theirs is
   * still enabled or held.
   */
  async function reconcile(): Promise<void> {
    const rows = await deps.db
      .select()
      .from(apps)
      .where(
        sql`${apps.automation}->>'merge' IS NOT NULL AND (${apps.automation}->>'merge' <> 'off'
          OR EXISTS (SELECT 1 FROM automation_runs r WHERE r.app_id = ${apps.id} AND r.kind = 'pr'
            AND (r.snapshot->>'appEnabled' = 'true' OR jsonb_typeof(r.snapshot->'held') = 'object')))`,
      );
    for (const app of rows) {
      const settings = automationOf(app);
      try {
        const connection = await connectionOf(app);
        const github = openGitHub(app, connection);
        const main =
          settings.merge === 'off'
            ? { state: 'unknown' as MainState, sha: null }
            : await mainState(app, github);
        await observeMain(app, main);
        const known = await deps.db
          .select({
            key: automationRuns.key,
            state: automationRuns.state,
            snapshot: automationRuns.snapshot,
          })
          .from(automationRuns)
          .where(and(eq(automationRuns.appId, app.id), eq(automationRuns.kind, 'pr')));
        const leftovers = known
          .filter(
            (run) =>
              (run.snapshot as { appEnabled?: unknown }).appEnabled === true ||
              heldOf(run.snapshot) !== null,
          )
          .map((run) => numberOfKey(run.key));
        const open =
          settings.merge === 'off'
            ? []
            : (await github.openDependabotPulls())
                .map((pull) => pull.number)
                .slice(0, MAX_PULLS_PER_TICK);
        const vanished = known
          .filter((run) => !['closed', 'merged'].includes(run.state))
          .map((run) => numberOfKey(run.key))
          .filter((n) => Number.isInteger(n) && !open.includes(n));
        const stuck: number[] = [];
        const targets = settings.merge === 'off' ? leftovers : [...open, ...vanished];
        for (const number of [...new Set(targets)]) {
          try {
            // A pull request somebody else is working on is skipped until the next pass.
            const ran = await handle({ app, connection, number, main: main.state, waitMs: 0 });
            if (ran === 'done') await clearFailures(app.id, number);
          } catch (error) {
            logger.warn(
              { appId: app.id, pull: number, reason: message(error) },
              'reconciling a pull request failed',
            );
            // A disable `decide` asked for failed, in any mode: the auto-merge may still be on.
            if (error instanceof DisableFailed) stuck.push(number);
            await noteFailure(app, number).catch(() => undefined);
          } finally {
            flushLater(app.id, runKey(number));
          }
        }
        if (stuck.length > 0) {
          await emitNotice(app.id, {
            kind: 'stuck-enabled',
            numbers: stuck.sort((a, b) => a - b),
            hour: new Date().toISOString().slice(0, 13),
          });
        }
      } catch (error) {
        logger.warn(
          { appId: app.id, reason: message(error) },
          'reconciling the automation of an app failed',
        );
        if (error instanceof NoUsableGitHub) {
          await emitNotice(app.id, {
            kind: 'no-github',
            mode: settings.merge,
            day: new Date().toISOString().slice(0, 10),
          }).catch(() => undefined);
        }
      }
    }
    await flushPending();
  }

  return {
    /**
     * A pull request opened, reopened, got a new head, changed its base or draft state, or closed.
     * Records the head's checks as held (`target`, when the event would run checks) and returns;
     * the classification runs in the background, and the held checks are queued once the head is
     * recorded (or by the reconcile). `held`: the caller queues no check for this app itself.
     */
    async onPullRequest(
      app: AppRow,
      connection: ConnectionRow,
      number: number,
      payloadSha: string,
      target: CommitTarget | null,
    ): Promise<{ held: boolean }> {
      if (!(await isActive(app, number))) return { held: false };
      const holds = await holdsChecks(app, number);
      if (holds && target !== null) await hold(app.id, number, payloadSha, target);
      runLater(app, connection, number);
      return { held: holds };
    },

    /**
     * A push to a branch: the pull requests with that head are handled like an `opened` event.
     * `held` when a `dependabot/*` head is handled here; a head without a pull request yet waits
     * for its `opened` event.
     */
    async onPush(
      app: AppRow,
      connection: ConnectionRow,
      branch: string,
      sha: string,
      target: CommitTarget | null,
    ): Promise<{ held: boolean }> {
      if (!branch.startsWith('dependabot/') || !(await isActive(app, null))) {
        return { held: false };
      }
      const github = openGitHub(app, connection);
      const numbers = await github.pullsWithHead(sha);
      let held = automationOf(app).merge === 'on';
      for (const number of numbers) {
        const holds = await holdsChecks(app, number);
        held ||= holds;
        if (holds && target !== null) await hold(app.id, number, sha, target);
        runLater(app, connection, number);
      }
      return { held };
    },

    reconcile,
    flushPending,

    /** Waits for the background work of this process (tests, shutdown). */
    async drain(): Promise<void> {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    /**
     * Whether an app of this repository (names compared without case) has its automation on or in
     * shadow: the checks of every app of the repository are then the gate an auto-merge relies on,
     * because commit status contexts are not scoped to the app that posts them.
     */
    async isRepositoryAutomated(owner: string, name: string): Promise<boolean> {
      return repositoryAutomated(owner, name);
    },

    /** The same for the repository of an app (it may be the automated one or a sibling). */
    async isRepositoryOfAppAutomated(appId: AppId): Promise<boolean> {
      const app = await readApp(appId);
      return app !== undefined && (await repositoryAutomated(app.repoOwner, app.repoName));
    },

    /**
     * Running or re-running checks of an app that is not itself automated, on a repository that
     * has an automated app, is a way to post the automated app's check contexts: it needs a
     * passkey session.
     */
    async isSiblingOfAutomated(appId: AppId): Promise<boolean> {
      const app = await readApp(appId);
      if (!app) return false;
      const own = automationOf(app);
      if (own.merge !== 'off' || own.train !== 'off') return false;
      return repositoryAutomated(app.repoOwner, app.repoName);
    },

    /**
     * While an app of the repository is automated, another app of it may not run checks that share
     * a name with the automated app's (409, whatever the session): `patch` is the change to the
     * checks settings of `appId`.
     */
    async assertChecksChangeAllowed(
      appId: AppId,
      patch: { enabled?: boolean | undefined; items?: readonly { name: string }[] | undefined },
    ): Promise<void> {
      const app = await readApp(appId);
      if (!app) return;
      const current = checksSettingsOf(app);
      const enabled = patch.enabled ?? current.enabled;
      if (!enabled) return;
      const names = (patch.items ?? current.items).map((item) => item.name);
      const own = automationOf(app);
      if (own.merge !== 'off' || own.train !== 'off') return;
      // The automated apps are the siblings that matter: their names are the gate.
      const automated = await deps.db
        .select()
        .from(apps)
        .where(
          and(
            ne(apps.id, app.id),
            sql`lower(${apps.repoOwner}) = ${app.repoOwner.toLowerCase()}`,
            sql`lower(${apps.repoName}) = ${app.repoName.toLowerCase()}`,
            sql`(${apps.automation}->>'merge' <> 'off' OR ${apps.automation}->>'train' <> 'off')`,
          ),
        );
      const gate = new Set(automated.flatMap((a) => checksSettingsOf(a).items.map((i) => i.name)));
      const clash = names.filter((name) => gate.has(name));
      if (clash.length > 0) {
        throw conflict(
          `An automated app of this repository uses the check names ${[...new Set(clash)].join(', ')}; their statuses are what its auto-merge waits for`,
        );
      }
    },

    /** Whether deleting the app would lose the gate: automation not off, or an enable on record. */
    async isAutomationLive(appId: AppId): Promise<boolean> {
      const app = await readApp(appId);
      if (!app) return false;
      const own = automationOf(app);
      return own.merge !== 'off' || own.train !== 'off' || (await hasRecordedEnable(app, null));
    },

    /** Withdraws the App's auto-merges of the app; run before the app's rows go. */
    withdraw(appId: AppId): Promise<AutomationSweep> {
      return sweep(appId);
    },

    /** The app a check run belongs to (undefined when there is no such run). */
    async appOfCheckRun(checkRunId: string): Promise<AppId | undefined> {
      const [row] = await deps.db
        .select({ appId: checkRuns.appId })
        .from(checkRuns)
        .where(eq(checkRuns.id, checkRunId as never));
      return row?.appId;
    },

    async listRuns(appId: AppId): Promise<AutomationRun[]> {
      const rows = await deps.db
        .select()
        .from(automationRuns)
        .where(and(eq(automationRuns.appId, appId), eq(automationRuns.kind, 'pr')))
        .orderBy(desc(automationRuns.updatedAt))
        .limit(RECENT_RUNS);
      return rows.map(toApiRun);
    },

    async get(appId: AppId): Promise<AppAutomationSettings> {
      const app = await readApp(appId);
      if (!app) throw notFound('App not found');
      return automationOf(app);
    },

    /**
     * Changes the settings (a passkey session; the route checks) and audits the change. Turning
     * the pause on or moving `merge` away from `on` waits for the sweep of the App's auto-merges.
     */
    async update(
      appId: AppId,
      input: UpdateAppAutomation,
      actor: RequestActor,
    ): Promise<AutomationChange> {
      const result = await deps.db.transaction(async (tx) => {
        const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update');
        if (!app) throw notFound('App not found');
        const before = automationOf(app);
        const after: AppAutomationSettings = {
          ...before,
          ...(Object.fromEntries(
            Object.entries(input).filter(([, value]) => value !== undefined),
          ) as Partial<AppAutomationSettings>),
        };
        if (after.merge !== 'off' || after.train !== 'off') {
          const connection = await findConnection(tx, app.connectionId);
          if (!connection) throw notFound('GitHub connection not found');
          if (connection.kind !== 'app' || connection.installationId === null) {
            throw conflict(
              'Automation needs a GitHub App connection that is installed on the account',
            );
          }
        }
        if (
          (input.merge !== undefined && input.merge !== 'off') ||
          (input.train !== undefined && input.train !== 'off')
        ) {
          // The auto-merge waits for `launchway/<name>` statuses, which every app of the
          // repository posts: a sibling running the same names could satisfy it.
          const clash = await siblingCheckNames(
            tx,
            app,
            checksSettingsOf(app).items.map((i) => i.name),
          );
          if (clash.length > 0) {
            throw conflict(
              `Another app of this repository runs checks named ${clash.join(', ')}; turn its checks off or rename them before automating`,
            );
          }
        }
        await tx.update(apps).set({ automation: after }).where(eq(apps.id, appId));
        await recordAudit(tx, actor, {
          action: 'app.automation.update',
          target: { type: 'app', id: appId },
          summary: diffSummary(before, after, Object.keys(input)),
        });
        return { before, after };
      });
      deps.events.publish({ topic: 'apps', action: 'updated', resourceId: appId });
      const { before, after } = result;
      const withdraws =
        (before.merge === 'on' && after.merge !== 'on') || (after.paused && !before.paused);
      return { ...after, sweep: withdraws ? await sweep(appId) : null };
    },

    /** Pauses the automation (tokens with write scope may) and withdraws the App's auto-merges. */
    async pause(appId: AppId, actor: RequestActor): Promise<AutomationChange> {
      const after = await deps.db.transaction(async (tx) => {
        const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update');
        if (!app) throw notFound('App not found');
        const before = automationOf(app);
        const next = { ...before, paused: true };
        await tx.update(apps).set({ automation: next }).where(eq(apps.id, appId));
        await recordAudit(tx, actor, {
          action: 'app.automation.pause',
          target: { type: 'app', id: appId },
          summary: diffSummary(before, next, ['paused']),
        });
        return next;
      });
      deps.events.publish({ topic: 'apps', action: 'updated', resourceId: appId });
      return { ...after, sweep: await sweep(appId) };
    },
  };
}
