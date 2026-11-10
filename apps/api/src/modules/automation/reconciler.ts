import type { Deps } from '../../deps.js';
import { startJob } from '../../lib/jobs.js';
import { createAutomationService } from './service.js';

/** The automation looks at every open Dependabot pull request this often (plan §3.3). */
export const AUTOMATION_RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

/** Starts the reconcile pass; it stops on shutdown or when the returned function is called. */
export function startAutomationReconciler(deps: Deps): () => void {
  const service = createAutomationService(deps);
  const job = startJob({
    name: 'automation-reconciler',
    intervalMs: AUTOMATION_RECONCILE_INTERVAL_MS,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => service.reconcile(),
  });
  return job.stop;
}
