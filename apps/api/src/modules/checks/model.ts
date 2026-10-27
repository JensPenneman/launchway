import {
  type AppChecksSettings,
  type CheckItem,
  type CheckRun,
  type CheckRunStatus,
  DEFAULT_APP_CHECKS_SETTINGS,
  isActiveCheckRunStatus,
} from '@launchway/contracts';
import type { Deps } from '../../deps.js';
import type { EventBus } from '../../lib/event-bus.js';
import { type LogHub, logHubFor } from '../../lib/log-stream.js';
import type { checkRuns } from './schema.js';

export type CheckRunRow = typeof checkRuns.$inferSelect;

/** Status message of a run whose node went (or stayed) offline. */
export const NODE_OFFLINE_MESSAGE = 'The node went offline';

export function toCheckRun(row: CheckRunRow): CheckRun {
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
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
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
