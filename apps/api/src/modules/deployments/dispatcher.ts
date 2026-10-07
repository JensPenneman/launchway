import { type AppId, type DeploymentId, QUEUED_DEPLOYMENT_TIMEOUT_MS } from '@launchway/contracts';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { AgentRequestError, AgentUnavailableError } from '../../lib/agent-gateway.js';
import { systemActor } from '../../lib/auth-context.js';
import { GitProviderError } from '../../lib/git-provider.js';
import { startJob } from '../../lib/jobs.js';
import { loadDecryptedEnv } from '../apps/env.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { domains } from '../domains/schema.js';
import { getConnection, providerFor } from '../github/providers.js';
import { nodes } from '../nodes/schema.js';
import { routes } from '../routes/schema.js';
import { createSettingsService } from '../settings/service.js';
import { ACTIVE_STATUSES, announceStatus, type DeploymentRow } from './model.js';
import { buildDeployPayload } from './payload.js';
import { deployments } from './schema.js';

/** Interval of the worker that re-dispatches queued deployments and fails stale ones. */
export const DISPATCH_INTERVAL_MS = 15_000;
const MAX_DISPATCH_ATTEMPTS = 10;

type AppRow = typeof apps.$inferSelect;

export interface Dispatcher {
  /**
   * Sends the oldest queued deployment of the app to its node, unless another deployment of the
   * app is in progress or the node is offline. Never throws; failures are logged.
   */
  dispatchApp(appId: AppId): Promise<void>;
  /** One worker pass: fail deployments queued too long, then dispatch for online nodes. */
  tick(now?: Date): Promise<void>;
}

type DispatchOutcome = 'none' | 'sent' | 'failed' | 'deferred';

export function createDispatcher(deps: Deps): Dispatcher {
  const logger = deps.logger.child({ component: 'deployment-dispatcher' });
  const settings = createSettingsService(deps);

  /** Claims the next queued deployment (sets `startedAt`) under a lock on the app row. */
  async function claim(appId: AppId): Promise<{ app: AppRow; deployment: DeploymentRow } | null> {
    return deps.db.transaction(async (tx) => {
      const [app] = await tx.select().from(apps).where(eq(apps.id, appId)).for('update');
      if (!app) return null;
      const [busy] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.appId, appId),
            or(
              inArray(deployments.status, ACTIVE_STATUSES),
              and(eq(deployments.status, 'queued'), isNotNull(deployments.startedAt)),
            ),
          ),
        )
        .limit(1);
      if (busy) return null;
      const [next] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.appId, appId),
            eq(deployments.status, 'queued'),
            isNull(deployments.startedAt),
          ),
        )
        .orderBy(asc(deployments.createdAt), asc(deployments.id))
        .limit(1);
      if (!next || !deps.agents.isOnline(next.nodeId)) return null;
      const [claimed] = await tx
        .update(deployments)
        .set({ startedAt: new Date() })
        .where(eq(deployments.id, next.id))
        .returning();
      return claimed ? { app, deployment: claimed } : null;
    });
  }

  async function release(id: DeploymentId): Promise<void> {
    await deps.db
      .update(deployments)
      .set({ startedAt: null })
      .where(and(eq(deployments.id, id), eq(deployments.status, 'queued')));
  }

  async function fail(row: DeploymentRow, message: string): Promise<void> {
    const failed = await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(deployments)
        .set({ status: 'failed', statusMessage: message, finishedAt: new Date() })
        .where(and(eq(deployments.id, row.id), eq(deployments.status, 'queued')))
        .returning();
      if (updated) {
        await recordAudit(tx, systemActor('deployment-dispatcher'), {
          action: 'deployment.fail',
          target: { type: 'deployment', id: row.id },
          summary: { appId: row.appId, reason: message },
        });
      }
      return updated;
    });
    if (failed) announceStatus(deps, failed, true);
  }

  async function payloadFor(app: AppRow, deployment: DeploymentRow) {
    const connection = await getConnection(deps.db, app.connectionId);
    const clone = await providerFor(deps, connection).cloneCredentials(app.repoOwner, app.repoName);
    const [node] = await deps.db
      .select({ lanIp: nodes.lanIp, allowedBindRoots: nodes.allowedBindRoots })
      .from(nodes)
      .where(eq(nodes.id, deployment.nodeId));
    const appRoutes = await deps.db
      .select({ service: routes.appService, port: routes.appPort })
      .from(routes)
      .innerJoin(domains, eq(domains.id, routes.domainId))
      .where(and(eq(routes.appId, app.id), eq(routes.targetKind, 'app')));
    const { edgeNodeId } = await settings.get();
    return buildDeployPayload({
      deployment,
      app,
      clone,
      env: await loadDecryptedEnv(deps.db, deps.secrets, app.id),
      routes: appRoutes.flatMap((r) =>
        r.service !== null && r.port !== null ? [{ service: r.service, port: r.port }] : [],
      ),
      proxyNetwork: deps.config.proxyNetwork,
      nodeLanIp: node?.lanIp ?? null,
      nodeAllowedBindRoots: node?.allowedBindRoots ?? [],
      edgeNodeId,
    });
  }

  async function dispatchOnce(appId: AppId): Promise<DispatchOutcome> {
    const claimed = await claim(appId);
    if (!claimed) return 'none';
    const { app, deployment } = claimed;
    const context = { appId, deploymentId: deployment.id, nodeId: deployment.nodeId };
    try {
      const payload = await payloadFor(app, deployment);
      await deps.agents.deploy(deployment.nodeId, payload);
    } catch (error) {
      if (error instanceof AgentRequestError && error.code === 'timeout') {
        // The agent may still have it (busy, slow link): keep the claim. Its heartbeats list what
        // it queues; the sink releases the claim for a re-send if the deployment never shows up.
        logger.warn({ ...context, reason: error.message }, 'deployment dispatch unacknowledged');
        return 'sent';
      }
      const transient =
        error instanceof AgentUnavailableError ||
        (error instanceof GitProviderError && error.kind === 'upstream');
      if (transient) {
        await release(deployment.id);
        logger.warn({ ...context, reason: error.message }, 'deployment dispatch deferred');
        return 'deferred';
      }
      const reason = error instanceof Error ? error.message : 'unknown error';
      logger.warn({ ...context, reason }, 'deployment dispatch failed');
      await fail(deployment, `Dispatch failed: ${reason}`);
      return 'failed';
    }
    logger.info(context, 'deployment dispatched');
    deps.events.publish({
      topic: 'deployments',
      action: 'updated',
      resourceId: deployment.id,
      data: { appId, status: deployment.status, dispatched: true },
    });
    return 'sent';
  }

  async function dispatchApp(appId: AppId): Promise<void> {
    try {
      // A failed dispatch frees the app for the next queued deployment.
      for (let attempt = 0; attempt < MAX_DISPATCH_ATTEMPTS; attempt += 1) {
        if ((await dispatchOnce(appId)) !== 'failed') return;
      }
    } catch (error) {
      logger.error({ err: error, appId }, 'deployment dispatch errored');
    }
  }

  return {
    dispatchApp,

    async tick(now = new Date()) {
      // Only deployments whose node has been offline for the whole timeout: one that waits
      // behind a long build on an online node is not stale.
      const cutoff = new Date(now.getTime() - QUEUED_DEPLOYMENT_TIMEOUT_MS);
      const stale = await deps.db
        .select({ deployment: deployments })
        .from(deployments)
        .innerJoin(nodes, eq(nodes.id, deployments.nodeId))
        .where(
          and(
            eq(deployments.status, 'queued'),
            lt(deployments.createdAt, cutoff),
            or(isNull(nodes.lastSeenAt), lt(nodes.lastSeenAt, cutoff)),
          ),
        );
      for (const { deployment } of stale) {
        if (deps.agents.isOnline(deployment.nodeId)) continue;
        await fail(deployment, 'Timed out waiting for the node to accept the deployment');
      }

      const waiting = await deps.db
        .selectDistinct({ appId: deployments.appId, nodeId: deployments.nodeId })
        .from(deployments)
        .where(and(eq(deployments.status, 'queued'), isNull(deployments.startedAt)));
      for (const { appId, nodeId } of waiting) {
        if (deps.agents.isOnline(nodeId)) await dispatchApp(appId);
      }
    },
  };
}

/** Starts the dispatch worker; it stops on shutdown or when the returned function is called. */
export function startDeploymentWorker(deps: Deps, intervalMs = DISPATCH_INTERVAL_MS): () => void {
  const dispatcher = createDispatcher(deps);
  const job = startJob({
    name: 'deployment-dispatcher',
    intervalMs,
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => dispatcher.tick(),
  });
  return job.stop;
}
