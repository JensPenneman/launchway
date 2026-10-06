import { GITHUB_RELEASE_POLL_INTERVAL_MS, type GitHubConnectionId } from '@slipway/contracts';
import { and, eq, lt } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { systemActor } from '../../lib/auth-context.js';
import type { GitProvider } from '../../lib/git-provider.js';
import { apps } from '../apps/schema.js';
import { createDeploymentsService } from '../deployments/service.js';
import { providerFor } from './providers.js';
import { githubConnections, githubWebhookDeliveries } from './schema.js';

/** Processed webhook deliveries are kept this long for replay protection. */
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Auto-deploy for PAT connections (no webhooks): deploys the latest release of every app with
 * `autoDeployReleases` when it was published after the app was created and was never deployed.
 */
export function createReleasePoller(deps: Deps) {
  const logger = deps.logger.child({ component: 'github-release-poller' });
  const deployments = createDeploymentsService(deps);
  const actor = systemActor('github-release-poller');

  return {
    async tick(now = new Date()): Promise<void> {
      await deps.db
        .delete(githubWebhookDeliveries)
        .where(
          lt(githubWebhookDeliveries.receivedAt, new Date(now.getTime() - DELIVERY_RETENTION_MS)),
        );

      const rows = await deps.db
        .select({ app: apps, connection: githubConnections })
        .from(apps)
        .innerJoin(githubConnections, eq(githubConnections.id, apps.connectionId))
        .where(and(eq(apps.autoDeployReleases, true), eq(githubConnections.kind, 'pat')));
      const providers = new Map<GitHubConnectionId, GitProvider>();
      for (const { app, connection } of rows) {
        try {
          let provider = providers.get(connection.id);
          if (!provider) {
            provider = providerFor(deps, connection);
            providers.set(connection.id, provider);
          }
          const release = await provider.latestRelease(app.repoOwner, app.repoName);
          if (!release?.publishedAt || release.draft || release.prerelease) continue;
          if (Date.parse(release.publishedAt) <= app.createdAt.getTime()) continue;
          const deployment = await deployments.createForRelease(app, release.tagName, actor);
          if (deployment) {
            logger.info({ appId: app.id, deploymentId: deployment.id }, 'release auto-deployed');
          }
        } catch (error) {
          logger.warn(
            { appId: app.id, reason: error instanceof Error ? error.message : 'unknown' },
            'release poll failed',
          );
        }
      }
    },
  };
}

/** Starts the poller; it stops on shutdown or when the returned function is called. */
export function startReleasePoller(
  deps: Deps,
  intervalMs = GITHUB_RELEASE_POLL_INTERVAL_MS,
): () => void {
  const poller = createReleasePoller(deps);
  let running = false;
  const timer = setInterval(() => {
    if (running || deps.lifecycle.shuttingDown) return;
    running = true;
    poller
      .tick()
      .catch((error: unknown) => deps.logger.error({ err: error }, 'release poller failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  deps.lifecycle.signal.addEventListener('abort', stop, { once: true });
  return stop;
}
