import type { Deps } from '../../deps.js';
import { startJob } from '../../lib/jobs.js';
import { createCheckDispatcher } from './dispatcher.js';
import { createChecksService } from './service.js';

/** Interval of the pass that errors runs left by their node and dispatches queued ones. */
export const CHECK_DISPATCH_INTERVAL_MS = 15_000;
/** Interval of the log retention pass. */
export const CHECK_LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** The first retention pass runs this soon after start (restarts must not postpone it). */
const FIRST_PRUNE_DELAY_MS = 60_000;

/**
 * Background work of the checks (ADR 0020): the dispatcher pass every 15 s and the hourly
 * pruning of log lines past their retention. Started from the composition root; stops on
 * shutdown or when the returned function is called.
 */
export function startChecksWorker(deps: Deps): () => void {
  const dispatcher = createCheckDispatcher(deps);
  const service = createChecksService(deps);
  const dispatch = startJob({
    name: 'check-dispatcher',
    intervalMs: CHECK_DISPATCH_INTERVAL_MS,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => dispatcher.tick(),
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
    prune.stop();
  };
}
