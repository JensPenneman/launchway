import {
  type AppStatusPayload,
  canTransition,
  type DeploymentId,
  type DeploymentLogPayload,
  type DeploymentProgressPayload,
  type DeploymentResultPayload,
  type DeploymentStatus,
  isInProgressStatus,
  type LogLine,
  type NodeId,
} from '@slipway/contracts';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import type { DeploymentSink } from '../../lib/agent-gateway.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { createDispatcher } from './dispatcher.js';
import { logHubFor } from './log-hub.js';
import { ACTIVE_STATUSES, agentActor, announceStatus, type DeploymentRow } from './model.js';
import { deploymentLogLines, deployments } from './schema.js';

export const NODE_OFFLINE_MESSAGE = 'node went offline';

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
          superseded = await tx
            .update(deployments)
            .set({ status: 'superseded', finishedAt: now })
            .where(
              and(
                eq(deployments.appId, row.appId),
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
            statusMessage: payload.outcome === 'failed' ? payload.error.message : null,
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
            ...(superseded.length > 0 ? { superseded: superseded.map((s) => s.id) } : {}),
          },
        });
        return { updated, superseded };
      });
      if (!changed) return;

      logger.info({ deploymentId: row.id, status: target }, 'deployment finished');
      for (const previous of changed.superseded) announceStatus(deps, previous, false);
      announceStatus(deps, changed.updated, true);
      deps.events.publish({
        topic: 'apps',
        action: 'updated',
        resourceId: row.appId,
        data: { activeDeploymentId: target === 'running' ? row.id : null },
      });
      await dispatcher.dispatchApp(row.appId);
    },

    async onAppStatus(nodeId, payload: AppStatusPayload) {
      const updated = await deps.db
        .update(deployments)
        .set({ services: payload.services })
        .where(
          and(
            eq(deployments.appId, payload.appId),
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
          .set({ status: 'failed', statusMessage: NODE_OFFLINE_MESSAGE, finishedAt: new Date() })
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
