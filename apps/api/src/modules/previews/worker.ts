import { PreviewId } from '@launchway/contracts';
import type { Deps } from '../../deps.js';
import { startJob } from '../../lib/jobs.js';
import { createPreviewsService } from './service.js';

/** Interval of the preview worker (finish removals, re-sync, purge). */
export const PREVIEW_WORKER_INTERVAL_MS = 60_000;

/**
 * Keeps previews in step with their deployments: every deployment change that names a preview
 * re-derives its status at once, and a periodic pass finishes removals that waited for a node or
 * the DNS provider, re-syncs open previews and purges closed ones after the retention period.
 * Started from the composition root; stops on shutdown or when the returned function is called.
 */
export function startPreviewWorker(
  deps: Deps,
  intervalMs = PREVIEW_WORKER_INTERVAL_MS,
): () => void {
  const service = createPreviewsService(deps);
  const logger = deps.logger.child({ component: 'preview-worker' });
  const unsubscribe = deps.events.subscribe((event) => {
    if (event.topic !== 'deployments') return;
    const parsed = PreviewId.safeParse(event.data?.previewId);
    if (!parsed.success) return;
    service.sync(parsed.data).catch((error: unknown) => {
      logger.warn({ err: error, previewId: parsed.data }, 'preview sync failed');
    });
  });
  const job = startJob({
    name: 'preview-worker',
    intervalMs,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => service.reconcile(),
  });
  const stop = () => {
    unsubscribe();
    job.stop();
  };
  deps.lifecycle.signal.addEventListener('abort', unsubscribe, { once: true });
  return stop;
}
