import {
  type AppId,
  type AppStatusPayload,
  canTransition,
  type DeploymentFailureReason,
  type DeploymentId,
  type DeploymentLogPayload,
  type DeploymentProgressPayload,
  type DeploymentResultPayload,
  type DeploymentStatus,
  isInProgressStatus,
  type LogLine,
  type NodeId,
  PRODUCTION_ENVIRONMENT,
} from '@launchway/contracts';
import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import type { DeploymentSink } from '../../lib/agent-gateway.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import {
  createDispatcher,
  IMAGE_RETRY_BUDGET_MS,
  isAutomaticTrigger,
  nextImageRetry,
} from './dispatcher.js';
import { logHubFor } from './log-hub.js';
import { ACTIVE_STATUSES, agentActor, announceStatus, type DeploymentRow } from './model.js';
import { deploymentLogLines, deployments } from './schema.js';

export const NODE_OFFLINE_MESSAGE = 'node went offline';
export const LOST_DEPLOYMENT_MESSAGE =
  'The node no longer reports this deployment; its result was lost';
export const MANUAL_IMAGE_HINT =
  'The image does not exist in the registry yet. Deploy again once it has been pushed (automatic deployments wait for it).';

/** Heartbeats in a row that must leave out a deployment before it is settled. */
const RECONCILE_AFTER_HEARTBEATS = 2;
/** Deployments claimed more recently than this are left alone (the deploy may be in flight). */
const RECONCILE_MIN_AGE_MS = 30_000;

/**
 * Receives what agents report (called by the nodes module for every matching message) and turns
 * it into deployment state: status transitions, persisted log lines, results and app status.
 */
export function createDeploymentSink(deps: Deps): DeploymentSink {
  const logger = deps.logger.child({ component: 'deployment-sink' });
  const dispatcher = createDispatcher(deps);
  const hub = logHubFor(deps.events);
  /** Per-deployment queue so log batches get gap-free, ordered sequence numbers. */
  const chains = new Map<DeploymentId, Promise<void>>();
  const nextSeq = new Map<DeploymentId, number>();
  /** In-progress deployments the node's last heartbeats did not list, with the count. */
  const unreported = new Map<DeploymentId, { nodeId: NodeId; count: number }>();

  /** Fails a deployment the agent no longer has (its result never reached the database). */
  async function failLost(nodeId: NodeId, row: DeploymentRow): Promise<void> {
    const failed = await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(deployments)
        .set({
          status: 'failed',
          statusMessage: LOST_DEPLOYMENT_MESSAGE,
          failureReason: null,
          finishedAt: new Date(),
        })
        .where(and(eq(deployments.id, row.id), eq(deployments.status, row.status)))
        .returning();
      if (updated) {
        await recordAudit(tx, agentActor(nodeId), {
          action: 'deployment.fail',
          target: { type: 'deployment', id: row.id },
          summary: { appId: row.appId, reason: LOST_DEPLOYMENT_MESSAGE },
        });
      }
      return updated;
    });
    if (!failed) return;
    nextSeq.delete(row.id);
    logger.warn({ nodeId, deploymentId: row.id }, 'failed a deployment the node no longer reports');
    announceStatus(deps, failed, true);
  }

  function serialize(id: DeploymentId, work: () => Promise<void>): Promise<void> {
    const run = (chains.get(id) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    chains.set(id, tail);
    void tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return run;
  }

  async function load(nodeId: NodeId, id: DeploymentId): Promise<DeploymentRow | null> {
    const [row] = await deps.db.select().from(deployments).where(eq(deployments.id, id));
    if (!row) {
      logger.warn({ nodeId, deploymentId: id }, 'agent reported an unknown deployment');
      return null;
    }
    if (row.nodeId !== nodeId) {
      logger.warn(
        { nodeId, deploymentId: id, expectedNodeId: row.nodeId },
        'agent reported a deployment of another node',
      );
      return null;
    }
    return row;
  }

  /** Appends a system line to the deployment's log, after the agent's lines. */
  function appendSystemLine(id: DeploymentId, text: string): Promise<void> {
    return serialize(id, async () => {
      const [max] = await deps.db
        .select({ value: sql<number | null>`max(${deploymentLogLines.seq})` })
        .from(deploymentLogLines)
        .where(eq(deploymentLogLines.deploymentId, id));
      const seq = max?.value === null || max?.value === undefined ? 0 : Number(max.value) + 1;
      const line: LogLine = {
        seq,
        timestamp: new Date().toISOString(),
        stream: 'system',
        line: text,
      };
      await deps.db.insert(deploymentLogLines).values({
        deploymentId: id,
        seq,
        stream: 'system',
        line: text,
        loggedAt: new Date(line.timestamp),
      });
      hub.publish(id, { kind: 'log', line });
    });
  }

  /**
   * Puts an automatic deployment whose image does not exist yet back in the queue until
   * `nextAttemptAt` (ADR 0019). The dispatcher sends it again once it is due.
   */
  async function scheduleImageRetry(
    nodeId: NodeId,
    row: DeploymentRow,
    retry: { retryCount: number; nextAttemptAt: Date },
  ): Promise<void> {
    const at = retry.nextAttemptAt.toISOString();
    const message = `Waiting for the image: retry ${retry.retryCount} at ${at}`;
    const updated = await deps.db.transaction(async (tx) => {
      await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, row.appId)).for('update');
      const [changed] = await tx
        .update(deployments)
        .set({
          status: 'queued',
          statusMessage: message,
          failureReason: 'image-not-found',
          retryCount: retry.retryCount,
          nextAttemptAt: retry.nextAttemptAt,
          startedAt: null,
          finishedAt: null,
        })
        .where(and(eq(deployments.id, row.id), eq(deployments.status, row.status)))
        .returning();
      if (!changed) return null;
      await recordAudit(tx, agentActor(nodeId), {
        action: 'deployment.retry',
        target: { type: 'deployment', id: row.id },
        summary: {
          appId: row.appId,
          reason: 'image-not-found',
          status: { from: row.status, to: 'queued' },
          retryCount: retry.retryCount,
          nextAttemptAt: at,
        },
      });
      return changed;
    });
    if (!updated) return;
    logger.info(
      { deploymentId: row.id, retryCount: retry.retryCount, nextAttemptAt: at },
      'image not found; deployment requeued',
    );
    await appendSystemLine(row.id, `Image not found in the registry. ${message}.`);
    announceStatus(deps, updated, false);
    // Another queued deployment of the app may go first; this one waits until it is due.
    await dispatcher.dispatchApp(row.appId);
  }

  return {
    async onProgress(nodeId, payload: DeploymentProgressPayload) {
      const row = await load(nodeId, payload.deploymentId);
      if (!row || row.status === payload.status) return;
      if (!canTransition(row.status, payload.status)) {
        logger.warn(
          { deploymentId: row.id, from: row.status, to: payload.status },
          'ignoring an invalid deployment transition',
        );
        return;
      }
      const [updated] = await deps.db
        .update(deployments)
        .set({
          status: payload.status,
          statusMessage: payload.message ?? null,
          startedAt: row.startedAt ?? new Date(),
        })
        .where(and(eq(deployments.id, row.id), eq(deployments.status, row.status)))
        .returning();
      if (!updated) return;
      logger.info({ deploymentId: row.id, status: updated.status }, 'deployment progressed');
      announceStatus(deps, updated, false);
    },

    onLog(nodeId, payload: DeploymentLogPayload) {
      return serialize(payload.deploymentId, async () => {
        const row = await load(nodeId, payload.deploymentId);
        if (!row) return;
        let seq = nextSeq.get(row.id);
        if (seq === undefined) {
          const [max] = await deps.db
            .select({ value: sql<number | null>`max(${deploymentLogLines.seq})` })
            .from(deploymentLogLines)
            .where(eq(deploymentLogLines.deploymentId, row.id));
          seq = max?.value === null || max?.value === undefined ? 0 : Number(max.value) + 1;
        }
        const lines: LogLine[] = payload.lines.map((line, index) => ({
          seq: (seq as number) + index,
          timestamp: new Date(line.timestamp).toISOString(),
          stream: line.stream,
          line: line.line,
        }));
        await deps.db.insert(deploymentLogLines).values(
          lines.map((line) => ({
            deploymentId: row.id,
            seq: line.seq,
            stream: line.stream,
            line: line.line,
            loggedAt: new Date(line.timestamp),
          })),
        );
        nextSeq.set(row.id, seq + lines.length);
        for (const line of lines) hub.publish(row.id, { kind: 'log', line });
      });
    },

    async onResult(nodeId, payload: DeploymentResultPayload) {
      const row = await load(nodeId, payload.deploymentId);
      if (!row) return;
      nextSeq.delete(row.id);
      if (!isInProgressStatus(row.status)) {
        logger.warn(
          { deploymentId: row.id, status: row.status, outcome: payload.outcome },
          'ignoring a result for a finished deployment',
        );
        return;
      }
      const failureReason: DeploymentFailureReason | null =
        payload.outcome === 'failed' ? (payload.reason ?? 'unknown') : null;
      if (
        failureReason === 'image-not-found' &&
        isAutomaticTrigger(row.trigger) &&
        canTransition(row.status, 'queued')
      ) {
        const retry = nextImageRetry(row.trigger, row.retryCount, new Date());
        if (retry) {
          await scheduleImageRetry(nodeId, row, retry);
          return;
        }
      }
      const target: DeploymentStatus =
        payload.outcome === 'succeeded'
          ? 'running'
          : payload.outcome === 'failed'
            ? 'failed'
            : 'cancelled';
      if (target === 'running' && row.status !== 'starting') {
        logger.warn(
          { deploymentId: row.id, from: row.status },
          'deployment succeeded without reporting every stage',
        );
      }

      const changed = await deps.db.transaction(async (tx) => {
        // Serializes with dispatching and other results of the same app.
        await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, row.appId)).for('update');
        const now = new Date();
        let superseded: DeploymentRow[] = [];
        if (target === 'running') {
          // Production and every preview are separate environments of the app.
          superseded = await tx
            .update(deployments)
            .set({ status: 'superseded', finishedAt: now })
            .where(
              and(
                eq(deployments.appId, row.appId),
                eq(deployments.environmentName, row.environmentName),
                eq(deployments.status, 'running'),
                ne(deployments.id, row.id),
              ),
            )
            .returning();
        }
        const [updated] = await tx
          .update(deployments)
          .set({
            status: target,
            statusMessage:
              payload.outcome === 'failed'
                ? failureMessage(row, failureReason, payload.error.message)
                : null,
            failureReason: target === 'running' ? null : (failureReason ?? row.failureReason),
            nextAttemptAt: null,
            ...(payload.outcome === 'succeeded' ? { services: payload.services } : {}),
            startedAt: row.startedAt ?? now,
            finishedAt: target === 'running' ? null : now,
          })
          .where(and(eq(deployments.id, row.id), eq(deployments.status, row.status)))
          .returning();
        if (!updated) return null;
        await recordAudit(tx, agentActor(nodeId), {
          action: `deployment.${payload.outcome === 'succeeded' ? 'succeed' : payload.outcome === 'failed' ? 'fail' : 'cancel'}`,
          target: { type: 'deployment', id: row.id },
          summary: {
            appId: row.appId,
            status: { from: row.status, to: target },
            ...(failureReason ? { reason: failureReason } : {}),
            ...(superseded.length > 0 ? { superseded: superseded.map((s) => s.id) } : {}),
          },
        });
        return { updated, superseded };
      });
      if (!changed) return;

      logger.info({ deploymentId: row.id, status: target }, 'deployment finished');
      for (const previous of changed.superseded) announceStatus(deps, previous, false);
      announceStatus(deps, changed.updated, true);
      if (row.previewId === null) {
        deps.events.publish({
          topic: 'apps',
          action: 'updated',
          resourceId: row.appId,
          data: { activeDeploymentId: target === 'running' ? row.id : null },
        });
      }
      await dispatcher.dispatchApp(row.appId);
    },

    async onAppStatus(nodeId, payload: AppStatusPayload) {
      const updated = await deps.db
        .update(deployments)
        .set({ services: payload.services })
        .where(
          and(
            eq(deployments.appId, payload.appId),
            eq(deployments.environmentName, PRODUCTION_ENVIRONMENT),
            eq(deployments.nodeId, nodeId),
            eq(deployments.status, 'running'),
          ),
        )
        .returning({ id: deployments.id });
      for (const { id } of updated) {
        deps.events.publish({
          topic: 'deployments',
          action: 'updated',
          resourceId: id,
          data: { appId: payload.appId, services: true },
        });
      }
    },

    async onHeartbeat(nodeId, activeDeploymentIds) {
      const active = new Set(activeDeploymentIds);
      const rows = await deps.db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.nodeId, nodeId),
            or(
              inArray(deployments.status, ACTIVE_STATUSES),
              and(eq(deployments.status, 'queued'), isNotNull(deployments.startedAt)),
            ),
          ),
        );
      const inProgress = new Set(rows.map((row) => row.id));
      for (const [id, entry] of unreported) {
        if (entry.nodeId === nodeId && !inProgress.has(id)) unreported.delete(id);
      }
      const cutoff = Date.now() - RECONCILE_MIN_AGE_MS;
      const freed = new Set<AppId>();
      for (const row of rows) {
        if (active.has(row.id)) {
          unreported.delete(row.id);
          continue;
        }
        const count = (unreported.get(row.id)?.count ?? 0) + 1;
        unreported.set(row.id, { nodeId, count });
        if (count < RECONCILE_AFTER_HEARTBEATS || (row.startedAt?.getTime() ?? 0) > cutoff) {
          continue;
        }
        unreported.delete(row.id);
        if (row.status === 'queued') {
          // Claimed and sent, but the agent never queued it: release it for a new dispatch.
          await deps.db
            .update(deployments)
            .set({ startedAt: null })
            .where(and(eq(deployments.id, row.id), eq(deployments.status, 'queued')));
          logger.warn({ nodeId, deploymentId: row.id }, 're-sending a deployment the node lacks');
        } else {
          await failLost(nodeId, row);
        }
        freed.add(row.appId);
      }
      // Not awaited: dispatching waits for the agent's acknowledgement on this same connection.
      for (const appId of freed) void dispatcher.dispatchApp(appId);
    },

    onNodeOnline(nodeId) {
      // Send what waited for this node now instead of on the next worker pass. Not awaited:
      // dispatching waits for the agent's acknowledgement, which must not hold up the gateway's
      // per-node state queue.
      void dispatcher.tick().catch((error: unknown) => {
        logger.error({ err: error, nodeId }, 'dispatch after the node came online failed');
      });
      return Promise.resolve();
    },

    async onNodeOffline(nodeId) {
      const failed = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .update(deployments)
          .set({
            status: 'failed',
            statusMessage: NODE_OFFLINE_MESSAGE,
            failureReason: null,
            finishedAt: new Date(),
          })
          .where(and(eq(deployments.nodeId, nodeId), inArray(deployments.status, ACTIVE_STATUSES)))
          .returning();
        // Sent but not yet started: the agent lost it, so dispatch it again once the node is back.
        await tx
          .update(deployments)
          .set({ startedAt: null })
          .where(
            and(
              eq(deployments.nodeId, nodeId),
              eq(deployments.status, 'queued'),
              isNotNull(deployments.startedAt),
            ),
          );
        for (const row of rows) {
          await recordAudit(tx, agentActor(nodeId), {
            action: 'deployment.fail',
            target: { type: 'deployment', id: row.id },
            summary: { appId: row.appId, reason: NODE_OFFLINE_MESSAGE },
          });
        }
        return rows;
      });
      for (const row of failed) {
        nextSeq.delete(row.id);
        announceStatus(deps, row, true);
      }
      if (failed.length > 0) {
        logger.warn(
          { nodeId, count: failed.length },
          'failed in-progress deployments of an offline node',
        );
      }
    },
  };
}

/** Status message of a failed deployment: the agent's error plus advice for missing images. */
export function failureMessage(
  row: Pick<DeploymentRow, 'trigger' | 'retryCount'>,
  reason: DeploymentFailureReason | null,
  error: string,
): string {
  if (reason !== 'image-not-found') return error;
  if (!isAutomaticTrigger(row.trigger)) return `${MANUAL_IMAGE_HINT}\n${error}`;
  if (row.retryCount === 0) return error;
  const minutes = Math.round(IMAGE_RETRY_BUDGET_MS / 60_000);
  return `Gave up after ${row.retryCount} retries over ${minutes} minutes: the image still does not exist in the registry.\n${error}`;
}
