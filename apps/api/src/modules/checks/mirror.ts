import {
  type AppId,
  type CheckRunId,
  checkStatusContext,
  type GitHubCommitStatusState,
  githubStateOfCheck,
  type PlatformEvent,
} from '@launchway/contracts';
import { and, asc, eq, gte, isNull, ne, or } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { apps } from '../apps/schema.js';
import {
  connectionOctokit,
  errorStatus,
  isRateLimited,
  type OctokitLike,
  requestWithRetry,
} from '../github/octokit.js';
import type { ConnectionRow } from '../github/providers.js';
import { githubConnections } from '../github/schema.js';
import {
  DENIAL_LOG_INTERVAL_MS,
  DENIAL_PAUSE_MS,
  forgetAfterDenial,
  githubConnectionState,
} from '../github/state.js';
import { createSettingsService } from '../settings/service.js';
import type { CheckRunRow } from './model.js';
import { checkRuns } from './schema.js';

/** The run fields a commit status is derived from. */
export type StatusRun = Pick<
  CheckRunRow,
  | 'id'
  | 'appId'
  | 'name'
  | 'commitSha'
  | 'status'
  | 'reason'
  | 'exitCode'
  | 'statusMessage'
  | 'timeoutMinutes'
  | 'githubState'
  | 'createdAt'
  | 'startedAt'
  | 'finishedAt'
>;

/** Everything one status step needs about a run, loaded fresh for every step. */
export interface StatusSnapshot {
  readonly run: StatusRun;
  readonly app: { readonly repoOwner: string; readonly repoName: string };
  readonly connection: ConnectionRow;
  /** Platform public URL (origin), for `target_url`. */
  readonly publicUrl: string | null;
}

export interface StatusStore {
  load(id: CheckRunId): Promise<StatusSnapshot | null>;
  /** Records the state last posted to GitHub; false when it was recorded already. */
  saveGitHubState(id: CheckRunId, state: GitHubCommitStatusState): Promise<boolean>;
  /** Runs created since `since` whose posted state is not the state of their status. */
  unsynced(since: Date): Promise<CheckRunId[]>;
}

export function createDbStatusStore(deps: Pick<Deps, 'db' | 'config' | 'events'>): StatusStore {
  const settings = createSettingsService(deps);
  return {
    async load(id) {
      const [row] = await deps.db
        .select({ run: checkRuns, app: apps, connection: githubConnections })
        .from(checkRuns)
        .innerJoin(apps, eq(apps.id, checkRuns.appId))
        .innerJoin(githubConnections, eq(githubConnections.id, apps.connectionId))
        .where(eq(checkRuns.id, id));
      if (!row) return null;
      return {
        run: row.run,
        app: { repoOwner: row.app.repoOwner, repoName: row.app.repoName },
        connection: row.connection,
        publicUrl: (await settings.get()).effectivePublicUrl,
      };
    },
    async saveGitHubState(id, state) {
      const updated = await deps.db
        .update(checkRuns)
        .set({ githubState: state })
        .where(
          and(
            eq(checkRuns.id, id),
            or(isNull(checkRuns.githubState), ne(checkRuns.githubState, state)),
          ),
        )
        .returning({ id: checkRuns.id });
      return updated.length > 0;
    },
    async unsynced(since) {
      const rows = await deps.db
        .select({ id: checkRuns.id, status: checkRuns.status, githubState: checkRuns.githubState })
        .from(checkRuns)
        .where(gte(checkRuns.createdAt, since))
        .orderBy(asc(checkRuns.createdAt), asc(checkRuns.id));
      return rows
        .filter((row) => row.githubState !== githubStateOfCheck(row.status))
        .map((row) => row.id);
    },
  };
}

const DESCRIPTION_MAX = 140;

function truncate(text: string): string {
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 3)}...` : text;
}

/** `45s`, `3m 20s`, `2h 5m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** A commit status to post. */
export interface CommitStatus {
  readonly state: GitHubCommitStatusState;
  readonly description: string;
}

function describe(run: StatusRun): string {
  // From the moment the run was sent to its node (checkout and build included) to its result.
  const start = run.startedAt ?? run.createdAt;
  const duration = () => formatDuration((run.finishedAt ?? start).getTime() - start.getTime());
  switch (run.status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'succeeded':
      return `Passed in ${duration()}`;
    case 'failed':
      if (run.reason === 'timeout') return `Timed out after ${run.timeoutMinutes} minutes`;
      return run.exitCode === null
        ? `Failed after ${duration()}`
        : `Failed: exit code ${run.exitCode} after ${duration()}`;
    case 'errored': {
      const first = run.statusMessage?.split('\n', 1)[0]?.trim();
      // "Not run: 28 queued and 5 new checks would exceed the app's limit of 30; run it again later"
      if (run.reason === 'queue-full' && first) return first;
      return `Error: ${first || run.reason || 'unknown'}`;
    }
    case 'cancelled':
      return run.reason === 'superseded' ? 'Superseded by a newer commit' : 'Cancelled';
  }
}

/**
 * What GitHub shows for a run as the commit status `launchway/<name>`: the state of
 * `githubStateOfCheck` and a description of at most 140 characters.
 */
export function commitStatusOf(run: StatusRun): CommitStatus {
  return { state: githubStateOfCheck(run.status), description: truncate(describe(run)) };
}

/** The run in the app's checks tab (`target_url`, "Details" on GitHub). */
export function checkTargetUrl(publicUrl: string, appId: AppId, id: CheckRunId): string {
  return `${publicUrl}/apps/${appId}?tab=checks&check=${id}`;
}

export type StatusOutcome =
  /** Nothing to do: unknown run (deleted), or the app's GitHub App is not installed. */
  | 'skipped'
  /** The commit status was posted. */
  | 'posted'
  /** GitHub already shows this status. */
  | 'unchanged'
  /** GitHub refused (missing permission or access), or statuses pause after a refusal. */
  | 'denied'
  /** Any other failure (logged); the next status change tries again. */
  | 'failed';

export interface ChecksMirrorOptions {
  readonly store?: StatusStore;
  /** Client acting as the connection; null when it cannot act (app not installed). */
  readonly octokitFor?: (connection: ConnectionRow) => Promise<OctokitLike | null>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** At start, runs created this recently whose state GitHub may not show are posted again. */
export const RESYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound of the "last posted status" memory. */
const MAX_REMEMBERED = 2000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

interface QueueEntry {
  again: boolean;
  done: Promise<void>;
}

class StatusDenied extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub refused the commit status (${status})`);
    this.status = status;
  }
}

/**
 * Reports check runs to GitHub as commit statuses `launchway/<name>` (ADR 0020), which branch
 * protection can require, driven by the `checks` change events that carry a status. Best effort:
 * failures are logged and never change a run. Steps of one run run one at a time and coalesce,
 * and each step reads the current state, so GitHub converges on the latest status.
 */
export function createChecksMirror(
  deps: Pick<Deps, 'db' | 'config' | 'events' | 'logger' | 'secrets' | 'lifecycle'>,
  options: ChecksMirrorOptions = {},
) {
  const logger = deps.logger.child({ component: 'github-checks-mirror' });
  const store = options.store ?? createDbStatusStore(deps);
  const octokitFor = options.octokitFor ?? ((row) => connectionOctokit(deps, row));
  const retry = { sleep: options.sleep ?? defaultSleep, now: options.now ?? Date.now };
  const now = retry.now;
  const shared = githubConnectionState(deps.events);
  /** Last status posted per run, so repeated events post nothing. */
  const posted = new Map<CheckRunId, CommitStatus>();
  const queues = new Map<CheckRunId, QueueEntry>();

  function isPosted(id: CheckRunId, status: CommitStatus): boolean {
    const last = posted.get(id);
    return last?.state === status.state && last.description === status.description;
  }

  function remember(id: CheckRunId, status: CommitStatus) {
    posted.delete(id);
    posted.set(id, status);
    if (posted.size > MAX_REMEMBERED) {
      const oldest = posted.keys().next().value;
      if (oldest !== undefined) posted.delete(oldest);
    }
  }

  function onDenied(connection: ConnectionRow, status: number) {
    const at = now();
    shared.statusDenials.set(connection.id, { at, status });
    forgetAfterDenial(shared, connection, at);
    const announced = shared.statusDenialAnnouncedAt.get(connection.id);
    if (announced !== undefined && at - announced < DENIAL_LOG_INTERVAL_MS) return;
    shared.statusDenialAnnouncedAt.set(connection.id, at);
    logger.warn(
      { connectionId: connection.id, status },
      'GitHub refused commit statuses for this connection; grant "statuses: write" (Commit statuses: read and write)',
    );
    deps.events.publish({
      topic: 'github',
      action: 'updated',
      resourceId: connection.id,
      data: { capabilities: true },
    });
  }

  function onAccepted(connection: ConnectionRow) {
    if (shared.statusDenials.delete(connection.id)) {
      shared.statusDenialAnnouncedAt.delete(connection.id);
      shared.capabilities.delete(connection.id);
    }
  }

  async function post(client: OctokitLike, snapshot: StatusSnapshot, status: CommitStatus) {
    const { run, app } = snapshot;
    try {
      await requestWithRetry(
        client,
        'POST /repos/{owner}/{repo}/statuses/{sha}',
        {
          owner: app.repoOwner,
          repo: app.repoName,
          sha: run.commitSha,
          state: status.state,
          description: status.description,
          context: checkStatusContext(run.name),
          ...(snapshot.publicUrl
            ? { target_url: checkTargetUrl(snapshot.publicUrl, run.appId, run.id) }
            : {}),
        },
        retry,
      );
    } catch (error) {
      const code = errorStatus(error);
      if ((code === 401 || code === 403 || code === 404) && !isRateLimited(error)) {
        throw new StatusDenied(code);
      }
      throw error;
    }
  }

  async function sync(id: CheckRunId): Promise<StatusOutcome> {
    const snapshot = await store.load(id);
    if (!snapshot) return 'skipped';
    const { run, connection } = snapshot;
    const target = commitStatusOf(run);
    if (isPosted(id, target)) return 'unchanged';
    const denial = shared.statusDenials.get(connection.id);
    if (denial && now() - denial.at < DENIAL_PAUSE_MS) return 'denied';
    try {
      const client = await octokitFor(connection);
      if (!client) return 'skipped';
      await post(client, snapshot, target);
      onAccepted(connection);
    } catch (error) {
      if (error instanceof StatusDenied) {
        onDenied(connection, error.status);
        return 'denied';
      }
      logger.warn(
        {
          runId: id,
          status: errorStatus(error),
          rateLimited: isRateLimited(error),
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'reporting a check run to GitHub failed',
      );
      return 'failed';
    }
    remember(id, target);
    if (run.githubState !== target.state && (await store.saveGitHubState(id, target.state))) {
      // No `status` key: the mirror ignores this event, the UI refreshes the run.
      deps.events.publish({
        topic: 'checks',
        action: 'updated',
        resourceId: id,
        data: { appId: run.appId, githubState: target.state },
      });
    }
    return 'posted';
  }

  /** Runs `sync` for a run after its previous step; queued steps coalesce into one. */
  function schedule(id: CheckRunId): Promise<void> {
    const queued = queues.get(id);
    if (queued) {
      queued.again = true;
      return queued.done;
    }
    const entry: QueueEntry = { again: true, done: Promise.resolve() };
    queues.set(id, entry);
    entry.done = (async () => {
      // Let the caller finish registering before the first step reads the state.
      await Promise.resolve();
      try {
        while (entry.again) {
          entry.again = false;
          try {
            await sync(id);
          } catch (error) {
            logger.warn({ err: error, runId: id }, 'check status step failed');
          }
        }
      } finally {
        queues.delete(id);
      }
    })();
    return entry.done;
  }

  function onEvent(event: PlatformEvent): void {
    if (event.topic !== 'checks' || !event.resourceId?.startsWith('chk_')) return;
    if (event.action === 'deleted') return;
    // Only status changes; the githubState events this mirror publishes carry no status.
    if (!event.data || !('status' in event.data)) return;
    void schedule(event.resourceId as CheckRunId);
  }

  /**
   * Posts the status of recent runs whose posted state is not their current one (statuses lost
   * to a restart or an outage), one run after the other.
   */
  async function resync(): Promise<void> {
    const ids = await store.unsynced(new Date(now() - RESYNC_WINDOW_MS));
    if (ids.length > 0) logger.info({ count: ids.length }, 'reporting check runs to GitHub again');
    for (const id of ids) {
      if (deps.lifecycle.shuttingDown) return;
      await schedule(id);
    }
  }

  return {
    sync,
    schedule,
    onEvent,
    resync,
    /** Resolves when every queued step finished (tests, shutdown). */
    async idle(): Promise<void> {
      while (queues.size > 0) {
        await Promise.all([...queues.values()].map((entry) => entry.done));
      }
    },
    /** Subscribes to the change feed until shutdown; returns the unsubscribe function. */
    start(): () => void {
      const unsubscribe = deps.events.subscribe(onEvent);
      deps.lifecycle.signal.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },
  };
}

/** Starts reporting check runs as commit statuses, after re-syncing recent ones (composition root). */
export function startChecksMirror(deps: Deps): () => void {
  const mirror = createChecksMirror(deps);
  const stop = mirror.start();
  mirror.resync().catch((error: unknown) => {
    deps.logger.warn({ err: error }, 're-syncing check statuses with GitHub failed');
  });
  return stop;
}
