import type { Deps } from '../../deps.js';
import { startJob } from '../../lib/jobs.js';
import { createCheckDispatcher } from './dispatcher.js';
import { createCheckScheduler } from './scheduler.js';
import { createChecksService } from './service.js';

/** Interval of the pass that errors runs left by their node and dispatches queued ones. */
export const CHECK_DISPATCH_INTERVAL_MS = 15_000;
/** Interval of the check schedule pass: a slot runs within a minute of its time. */
export const CHECK_SCHEDULE_INTERVAL_MS = 60_000;
/** Interval of the log retention pass. */
export const CHECK_LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** The first retention pass runs this soon after start (restarts must not postpone it). */
const FIRST_PRUNE_DELAY_MS = 60_000;

/**
 * Background work of the checks (ADR 0020): the dispatcher pass every 15 s, the schedule pass
 * every minute and the hourly pruning of log lines past their retention. Started from the
 * composition root; stops on shutdown or when the returned function is called.
 */
export function startChecksWorker(deps: Deps): () => void {
  const dispatcher = createCheckDispatcher(deps);
  const scheduler = createCheckScheduler(deps);
  const service = createChecksService(deps);
  const dispatch = startJob({
    name: 'check-dispatcher',
    intervalMs: CHECK_DISPATCH_INTERVAL_MS,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => dispatcher.tick(),
  });
  const schedule = startJob({
    name: 'check-scheduler',
    intervalMs: CHECK_SCHEDULE_INTERVAL_MS,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => scheduler.tick(),
  });
  const prune = startJob({
    name: 'check-log-pruner',
    intervalMs: CHECK_LOG_PRUNE_INTERVAL_MS,
    initialDelayMs: FIRST_PRUNE_DELAY_MS,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => service.pruneLogs(),
  });
  return () => {
    dispatch.stop();
    schedule.stop();
    prune.stop();
  };
}
