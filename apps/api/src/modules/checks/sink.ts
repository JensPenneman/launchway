import {
  CHECK_LOG_LINE_LIMIT,
  type CheckLogPayload,
  type CheckResultPayload,
  type CheckRunId,
  type CheckRunReason,
  type CheckRunStatus,
  type LogLine,
  type NodeId,
} from '@launchway/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import type { CheckSink } from '../../lib/agent-gateway.js';
import { agentActor } from '../../lib/auth-context.js';
import { recordAudit } from '../audit/service.js';
import { createCheckDispatcher } from './dispatcher.js';
import { announceStatus, type CheckRunRow, checkLogHub, NODE_OFFLINE_MESSAGE } from './model.js';
import { checkLogLines, checkRuns } from './schema.js';

export const LOST_RUN_MESSAGE = 'The node no longer reports this check; its result was lost';
/**
 * Lines stored per run at most: the agent sends CHECK_LOG_LINE_LIMIT lines plus a truncation line
 * and a few system lines; anything beyond is dropped.
 */
export const MAX_STORED_LINES = CHECK_LOG_LINE_LIMIT + 100;

/** Heartbeats in a row that must leave out a running run before it is settled as lost. */
const RECONCILE_AFTER_HEARTBEATS = 2;
/** Runs sent more recently than this are left alone (the run may still be on its way). */
const RECONCILE_MIN_AGE_MS = 30_000;

/** How a run ends for a `check.result`. */
export interface CheckOutcome {
  readonly status: Exclude<CheckRunStatus, 'queued' | 'running'>;
  readonly reason: CheckRunReason;
  readonly exitCode: number | null;
  readonly statusMessage: string | null;
}

const ERROR_MESSAGES = {
  policy: 'The Compose policy refused the project',
  build: 'Preparing the check failed',
  infrastructure: 'Docker could not run the check',
  interrupted: 'Interrupted: the agent shut down',
} as const;

const AUDIT_ACTIONS: Record<CheckOutcome['status'], string> = {
  succeeded: 'check.succeed',
  failed: 'check.fail',
  errored: 'check.error',
  cancelled: 'check.cancel',
};

/** A message set when the run was cancelled on purpose ("Cancelled: ...", "Superseded ..."). */
function cancelMessage(message: string | null): string | null {
  return message !== null && /^(Cancelled|Superseded)\b/.test(message) ? message : null;
}

/**
 * The outcome of a run from the agent's result: exit 0 succeeded; a non-zero exit or a timeout
 * failed (a verdict on the code); `cancelled` cancelled, keeping the message of a deliberate
 * cancel; policy, build, infrastructure and interrupted errored (no verdict).
 */
export function checkResultOutcome(
  run: Pick<CheckRunRow, 'statusMessage' | 'timeoutMinutes'>,
  result: Pick<CheckResultPayload, 'reason' | 'exitCode' | 'message'>,
): CheckOutcome {
  const { reason, exitCode } = result;
  const message = result.message ?? null;
  switch (reason) {
    case 'exit':
      if (exitCode === 0) return { status: 'succeeded', reason, exitCode, statusMessage: message };
      return {
        status: 'failed',
        reason,
        exitCode,
        statusMessage:
          message ??
          (exitCode === null ? 'Exited without an exit code' : `Exited with code ${exitCode}`),
      };
    case 'timeout':
      return {
        status: 'failed',
        reason,
        exitCode,
        statusMessage: message ?? `Timed out after ${run.timeoutMinutes} minutes`,
      };
    case 'cancelled':
      return {
        status: 'cancelled',
        reason,
        exitCode,
        statusMessage: cancelMessage(run.statusMessage) ?? message ?? 'Cancelled',
      };
    case 'policy':
    case 'build':
    case 'infrastructure':
    case 'interrupted':
      return {
        status: 'errored',
        reason,
        exitCode,
        statusMessage: message ?? ERROR_MESSAGES[reason],
      };
  }
}

/**
 * Receives what agents report about check runs (called by the nodes module for every matching
 * message): stores log lines with gap-free sequence numbers, settles results, reconciles the
 * runs a node reports in its heartbeats and dispatches the node's next run when one ends.
 */
export function createCheckSink(deps: Deps): CheckSink {
  const logger = deps.logger.child({ component: 'check-sink' });
  const dispatcher = createCheckDispatcher(deps);
  const hub = checkLogHub(deps.events);
  /** Per-run queue so log batches get gap-free, ordered sequence numbers. */
  const chains = new Map<CheckRunId, Promise<void>>();
  const nextSeq = new Map<CheckRunId, number>();
  /** Runs whose lines hit MAX_STORED_LINES (logged once). */
  const capped = new Set<CheckRunId>();
  /** Running runs the node's last heartbeats did not list, with the count. */
  const unreported = new Map<CheckRunId, { nodeId: NodeId; count: number }>();

  function forget(id: CheckRunId): void {
    nextSeq.delete(id);
    capped.delete(id);
    unreported.delete(id);
  }

  function serialize(id: CheckRunId, work: () => Promise<void>): Promise<void> {
    const run = (chains.get(id) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    chains.set(id, tail);
    void tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return run;
  }

  async function load(nodeId: NodeId, id: CheckRunId): Promise<CheckRunRow | null> {
    const [row] = await deps.db.select().from(checkRuns).where(eq(checkRuns.id, id));
    if (!row) {
      logger.warn({ nodeId, runId: id }, 'agent reported an unknown check run');
      return null;
    }
    if (row.nodeId !== nodeId) {
      logger.warn(
        { nodeId, runId: id, expectedNodeId: row.nodeId },
        'agent reported a check run of another node',
      );
      return null;
    }
    return row;
  }

  /** Errors a running run of the node (audited); returns the updated row. */
  async function failRunning(
    nodeId: NodeId,
    row: CheckRunRow,
    reason: CheckRunReason,
    message: string,
  ): Promise<CheckRunRow | undefined> {
    const updated = await deps.db.transaction(async (tx) => {
      const [changed] = await tx
        .update(checkRuns)
        .set({ status: 'errored', reason, statusMessage: message, finishedAt: new Date() })
        .where(and(eq(checkRuns.id, row.id), eq(checkRuns.status, 'running')))
        .returning();
      if (changed) {
        await recordAudit(tx, agentActor(nodeId), {
          action: 'check.error',
          target: { type: 'check', id: row.id },
          summary: {
            appId: row.appId,
            name: row.name,
            status: { from: 'running', to: 'errored' },
            reason,
          },
        });
      }
      return changed;
    });
    forget(row.id);
    if (updated) announceStatus(deps, updated);
    return updated;
  }

  return {
    onLog(nodeId, payload: CheckLogPayload) {
      return serialize(payload.runId, async () => {
        const row = await load(nodeId, payload.runId);
        if (row?.status !== 'running') return;
        let seq = nextSeq.get(row.id);
        if (seq === undefined) {
          const [max] = await deps.db
            .select({ value: sql<number | null>`max(${checkLogLines.seq})` })
            .from(checkLogLines)
            .where(eq(checkLogLines.runId, row.id));
          seq = max?.value === null || max?.value === undefined ? 0 : Number(max.value) + 1;
        }
        const room = MAX_STORED_LINES - seq;
        if (room <= 0) {
          if (!capped.has(row.id)) {
            capped.add(row.id);
            logger.warn({ nodeId, runId: row.id }, 'dropping lines beyond the check log limit');
          }
          return;
        }
        const first = seq;
        const lines: LogLine[] = payload.lines.slice(0, room).map((line, index) => ({
          seq: first + index,
          timestamp: new Date(line.timestamp).toISOString(),
          stream: line.stream,
          line: line.line,
        }));
        await deps.db.insert(checkLogLines).values(
          lines.map((line) => ({
            runId: row.id,
            seq: line.seq,
            stream: line.stream,
            line: line.line,
            loggedAt: new Date(line.timestamp),
          })),
        );
        nextSeq.set(row.id, first + lines.length);
        for (const line of lines) hub.publish(row.id, { kind: 'log', line });
      });
    },

    async onResult(nodeId, payload: CheckResultPayload) {
      const row = await load(nodeId, payload.runId);
      if (!row) return;
      if (row.status !== 'running') {
        forget(row.id);
        logger.info(
          { runId: row.id, status: row.status, reason: payload.reason },
          'ignoring a result for a check run that is not running',
        );
        return;
      }
      const outcome = checkResultOutcome(row, payload);
      const updated = await deps.db.transaction(async (tx) => {
        const [changed] = await tx
          .update(checkRuns)
          .set({ ...outcome, finishedAt: new Date() })
          .where(and(eq(checkRuns.id, row.id), eq(checkRuns.status, 'running')))
          .returning();
        if (!changed) return undefined;
        await recordAudit(tx, agentActor(nodeId), {
          action: AUDIT_ACTIONS[outcome.status],
          target: { type: 'check', id: row.id },
          summary: {
            appId: row.appId,
            name: row.name,
            status: { from: 'running', to: outcome.status },
            reason: outcome.reason,
            ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
          },
        });
        return changed;
      });
      forget(row.id);
      if (!updated) return;
      logger.info(
        { runId: row.id, appId: row.appId, status: updated.status, reason: updated.reason },
        'check run finished',
      );
      announceStatus(deps, updated);
      // Not awaited: dispatching waits for the agent's acknowledgement on this same connection.
      void dispatcher.dispatchNode(nodeId);
    },

    async onHeartbeat(nodeId, activeCheckRunIds) {
      // Agents without checks report nothing about them; their runs end by timeout or offline.
      if (activeCheckRunIds === undefined) return;
      const active = new Set(activeCheckRunIds);
      const running = await deps.db
        .select()
        .from(checkRuns)
        .where(and(eq(checkRuns.nodeId, nodeId), eq(checkRuns.status, 'running')));
      const runningIds = new Set<string>(running.map((row) => row.id));
      for (const [id, entry] of unreported) {
        if (entry.nodeId === nodeId && !runningIds.has(id)) unreported.delete(id);
      }
      const cutoff = Date.now() - RECONCILE_MIN_AGE_MS;
      let freed = false;
      for (const row of running) {
        if (active.has(row.id)) {
          unreported.delete(row.id);
          continue;
        }
        const count = (unreported.get(row.id)?.count ?? 0) + 1;
        unreported.set(row.id, { nodeId, count });
        if (count < RECONCILE_AFTER_HEARTBEATS || (row.startedAt?.getTime() ?? 0) > cutoff) {
          continue;
        }
        if (await failRunning(nodeId, row, 'lost', LOST_RUN_MESSAGE)) {
          logger.warn({ nodeId, runId: row.id }, 'errored a check run the node no longer reports');
          freed = true;
        }
      }
      const strays = [...active].filter((id) => !runningIds.has(id));
      if (strays.length > 0) {
        const known = await deps.db
          .select({ id: checkRuns.id, status: checkRuns.status })
          .from(checkRuns)
          .where(inArray(checkRuns.id, strays));
        // Queued again here (the socket dropped before the agent's answer): it is sent again and
        // the agent carries on with it.
        const requeued = new Set(known.filter((r) => r.status === 'queued').map((r) => r.id));
        for (const id of strays) {
          if (requeued.has(id)) continue;
          // Finished or unknown here (cancelled, timed out, deleted): stop it. Not awaited: the
          // agent answers on this same connection.
          logger.info({ nodeId, runId: id }, 'cancelling a check run the node should not run');
          deps.agents.cancelCheck(nodeId, id).catch((error: unknown) => {
            logger.debug({ err: error, nodeId, runId: id }, 'cancelling a stray check run failed');
          });
        }
      }
      if (freed) void dispatcher.dispatchNode(nodeId);
    },

    onNodeOnline(nodeId) {
      // Send what waited for this node now instead of on the next worker pass. Not awaited:
      // dispatching waits for the agent's acknowledgement, which must not hold up the gateway.
      void dispatcher.dispatchNode(nodeId);
      return Promise.resolve();
    },

    async onNodeOffline(nodeId) {
      const failed = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .update(checkRuns)
          .set({
            status: 'errored',
            reason: 'offline',
            statusMessage: NODE_OFFLINE_MESSAGE,
            finishedAt: new Date(),
          })
          .where(and(eq(checkRuns.nodeId, nodeId), eq(checkRuns.status, 'running')))
          .returning();
        for (const row of rows) {
          await recordAudit(tx, agentActor(nodeId), {
            action: 'check.error',
            target: { type: 'check', id: row.id },
            summary: {
              appId: row.appId,
              name: row.name,
              status: { from: 'running', to: 'errored' },
              reason: 'offline',
            },
          });
        }
        return rows;
      });
      for (const row of failed) {
        forget(row.id);
        announceStatus(deps, row);
      }
      if (failed.length > 0) {
        logger.warn(
          { nodeId, count: failed.length },
          'errored running check runs of an offline node',
        );
      }
    },
  };
}
