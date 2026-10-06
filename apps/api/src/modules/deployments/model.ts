import type { Deployment, DeploymentStatus, NodeId } from '@slipway/contracts';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { logHubFor } from './log-hub.js';
import type { deployments } from './schema.js';

export type DeploymentRow = typeof deployments.$inferSelect;

export function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    appId: row.appId,
    nodeId: row.nodeId,
    ref: row.ref,
    commitSha: row.commitSha,
    trigger: row.trigger,
    status: row.status,
    statusMessage: row.statusMessage,
    triggeredBy: row.triggeredById,
    services: row.services,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Audit actor for state reported by a node agent. */
export function agentActor(nodeId: NodeId): RequestActor {
  return {
    principal: null,
    ipAddress: null,
    userAgent: null,
    requestId: `agent:${nodeId}`,
    actor: { type: 'agent', id: nodeId, label: null },
  };
}

/**
 * Announces a status change after commit: the change feed (`deployments` topic) and the live
 * log stream of the deployment (`status`, plus `end` once it left the in-progress states).
 */
export function announceStatus(
  deps: Pick<Deps, 'events'>,
  row: Pick<DeploymentRow, 'id' | 'appId' | 'status'>,
  ended: boolean,
): void {
  deps.events.publish({
    topic: 'deployments',
    action: 'updated',
    resourceId: row.id,
    data: { appId: row.appId, status: row.status },
  });
  const hub = logHubFor(deps.events);
  hub.publish(row.id, { kind: 'status', status: row.status });
  if (ended) hub.publish(row.id, { kind: 'end', status: row.status });
}

/** Statuses in which the agent is (or may be) working on a deployment. */
export const ACTIVE_STATUSES = [
  'cloning',
  'building',
  'starting',
] as const satisfies readonly DeploymentStatus[];
