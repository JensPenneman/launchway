import {
  CHECK_LOG_RETENTION_MS,
  type CheckRun,
  type CheckRunReason,
  type CheckRunStatus,
  type CheckRunTrigger,
  isActiveCheckRunStatus,
} from '@launchway/contracts';
import { formatRelative } from '@/lib/format';

export const CHECK_TRIGGER_LABELS: Record<CheckRunTrigger, string> = {
  push: 'push',
  pull_request: 'pull request',
  manual: 'manual',
  schedule: 'schedule',
};

const OUTCOMES: Record<Exclude<CheckRunReason, 'exit' | 'timeout'>, string> = {
  policy: 'The Compose policy refused the project',
  build: 'Fetching the commit, reading the Compose files, building or pulling failed',
  infrastructure: 'Docker failed (the source volume, or a dependency that did not start)',
  interrupted: 'The agent shut down while the check ran',
  cancelled: 'Cancelled on request',
  superseded: 'A newer commit of the branch arrived while it waited',
  offline: 'Its node was offline for too long or went away',
  lost: 'Its node no longer reports it',
  unsupported: "Its node's agent does not run checks (update the agent)",
  dispatch: 'Launchway could not prepare it',
  'queue-full': 'The app or its node already had as many queued checks as allowed',
  closed: 'Its pull request was closed or merged before it ran',
  'same-tree':
    'Not run: the same check had run for a commit with the same files, and its result counts here',
};

/** Why a run ended, in words; null while it is queued or running. */
export function checkRunOutcome(
  run: Pick<CheckRun, 'reason' | 'exitCode' | 'timeoutMinutes'>,
): string | null {
  switch (run.reason) {
    case null:
      return null;
    case 'exit':
      return run.exitCode === null
        ? 'The command exited'
        : `The command exited with code ${run.exitCode}`;
    case 'timeout':
      return `Timed out after ${run.timeoutMinutes} ${run.timeoutMinutes === 1 ? 'minute' : 'minutes'}`;
    default:
      return OUTCOMES[run.reason];
  }
}

/** Where a queued run waits: "next on its node" or "behind 3 runs"; null for other runs. */
export function checkRunQueueLabel(run: Pick<CheckRun, 'status' | 'queuedBehind'>): string | null {
  if (run.status !== 'queued' || run.queuedBehind === null) return null;
  if (run.queuedBehind === 0) return 'next on its node';
  return `behind ${run.queuedBehind} ${run.queuedBehind === 1 ? 'run' : 'runs'}`;
}

/** "3 minutes ago" once sent to the node; "queued 3 minutes ago" before; "not started" if never. */
export function checkRunStartedLabel(
  run: Pick<CheckRun, 'status' | 'createdAt' | 'startedAt'>,
  now = Date.now(),
): string {
  if (run.startedAt) return formatRelative(run.startedAt, now);
  return isActiveCheckRunStatus(run.status)
    ? `queued ${formatRelative(run.createdAt, now)}`
    : 'not started';
}

const RETENTION_DAYS = Math.round(CHECK_LOG_RETENTION_MS / (24 * 60 * 60 * 1000));

/** What the log view says while a run has no lines. */
export function checkLogEmptyText(status: CheckRunStatus, reason?: CheckRunReason | null): string {
  if (reason === 'same-tree') {
    return 'No output: this run reused the result of a run of the same tree, whose logs are there.';
  }
  switch (status) {
    case 'queued':
      return 'Queued: the check starts once its node is free (a node runs one check at a time).';
    case 'running':
      return 'No output yet.';
    default:
      return `No output. Check logs are kept for ${RETENTION_DAYS} days.`;
  }
}
