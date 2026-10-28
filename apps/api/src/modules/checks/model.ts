import {
  type AppChecksSettings,
  type CheckItem,
  type CheckRun,
  type CheckRunId,
  type CheckRunStatus,
  DEFAULT_APP_CHECKS_SETTINGS,
  isActiveCheckRunStatus,
  type NodeId,
} from '@launchway/contracts';
import type { Deps } from '../../deps.js';
import type { EventBus } from '../../lib/event-bus.js';
import { type LogHub, logHubFor } from '../../lib/log-stream.js';
import type { checkRuns } from './schema.js';

export type CheckRunRow = typeof checkRuns.$inferSelect;

/** GitHub's description of the runs a closed or merged pull request cancelled. */
export const PULL_REQUEST_CLOSED_DESCRIPTION = 'Pull request closed';
/** GitHub's description of the runs a deleted branch cancelled. */
export const BRANCH_DELETED_DESCRIPTION = 'Branch deleted';
/** Start of the status message of runs a deleted branch cancelled. */
export const BRANCH_DELETED_PREFIX = 'Cancelled: branch ';
/** Status message of a run whose node went (or stayed) offline. */
export const NODE_OFFLINE_MESSAGE = 'The node went offline';
/** Status message of runs of a node whose agent does not run checks. */
export const UNSUPPORTED_AGENT_MESSAGE =
  'The agent of this node does not run checks: it is older than the control plane. Update the agent.';

/**
 * What the dispatcher and the sink of one process know about the agents' checks (shared through
 * the event bus, like the log hub). Agents that run checks list their runs in every heartbeat, so
 * a heartbeat without that list proves an agent without checks; until the first heartbeat of a
 * connection it is unknown. Runs sent without an acknowledgement wait for the heartbeats to tell
 * whether the agent has them.
 */
export interface CheckNodeState {
  /** true: the node's agent runs checks; false: it does not; absent: no heartbeat yet. */
  readonly capable: Map<NodeId, boolean>;
  /** Runs sent to their node that the agent has not acknowledged (nor reported) yet. */
  readonly unacknowledged: Set<CheckRunId>;
}

const nodeStates = new WeakMap<EventBus, CheckNodeState>();

export function checkNodeState(events: EventBus): CheckNodeState {
  let state = nodeStates.get(events);
  if (!state) {
    state = { capable: new Map(), unacknowledged: new Set() };
    nodeStates.set(events, state);
  }
  return state;
}

/** The API shape of a run; `queuedBehind` is the run's place in its node's queue (queued only). */
export function toCheckRun(row: CheckRunRow, queuedBehind: number | null = null): CheckRun {
  return {
    id: row.id,
    appId: row.appId,
    nodeId: row.nodeId,
    name: row.name,
    command: row.command,
    service: row.service,
    composeFiles: row.composeFiles,
    timeoutMinutes: row.timeoutMinutes,
    commitSha: row.commitSha,
    ref: row.ref,
    prNumber: row.prNumber,
    trigger: row.trigger,
    status: row.status,
    reason: row.reason,
    exitCode: row.exitCode,
    statusMessage: row.statusMessage,
    githubState: row.githubState,
    triggeredBy: row.triggeredById,
    treeSha: row.treeSha,
    copiedFrom: row.copiedFromId,
    alsoRef: row.alsoRef,
    queuedBehind: row.status === 'queued' ? queuedBehind : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `45s`, `3m 20s`, `2h 5m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** The check settings of an app row; keys stored before they existed get their defaults. */
export function checksSettingsOf(app: { readonly checks: AppChecksSettings }): AppChecksSettings {
  return { ...DEFAULT_APP_CHECKS_SETTINGS, ...app.checks };
}

/**
 * The configuration a run keeps from its check, taken when the run is queued: a check with its
 * own Compose file runs with that file only, the others with the composeFiles of the checks.
 */
export function runSnapshot(
  item: CheckItem,
  settings: Pick<AppChecksSettings, 'composeFiles'>,
): Pick<CheckRunRow, 'name' | 'command' | 'service' | 'composeFiles' | 'timeoutMinutes'> {
  return {
    name: item.name,
    command: item.command,
    service: item.service,
    composeFiles: item.composeFile ? [item.composeFile] : [...settings.composeFiles],
    timeoutMinutes: item.timeoutMinutes,
  };
}

/** Live output of check runs, from the check sink to `GET /checks/{id}/logs?follow=true`. */
export function checkLogHub(events: EventBus): LogHub<CheckRunStatus> {
  return logHubFor<CheckRunStatus>(events, 'checks');
}

type Announced = Pick<CheckRunRow, 'id' | 'appId' | 'status'>;

/** A queued run, after commit: the change feed (`checks` created). */
export function announceCreated(deps: Pick<Deps, 'events'>, row: Announced): void {
  deps.events.publish({
    topic: 'checks',
    action: 'created',
    resourceId: row.id,
    data: { appId: row.appId, status: row.status },
  });
}

/**
 * A status change, after commit: the change feed (`checks` updated with the status, which the
 * commit status mirror follows) and the run's live log stream (`status`, plus `end` once the run
 * finished).
 */
export function announceStatus(deps: Pick<Deps, 'events'>, row: Announced): void {
  deps.events.publish({
    topic: 'checks',
    action: 'updated',
    resourceId: row.id,
    data: { appId: row.appId, status: row.status },
  });
  const hub = checkLogHub(deps.events);
  hub.publish(row.id, { kind: 'status', status: row.status });
  if (!isActiveCheckRunStatus(row.status)) hub.publish(row.id, { kind: 'end', status: row.status });
}
