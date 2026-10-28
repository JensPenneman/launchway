import { type CheckRunReason, type NodeId, QUEUED_CHECK_TIMEOUT_MS } from '@launchway/contracts';
import { and, asc, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { AgentRequestError, AgentUnavailableError } from '../../lib/agent-gateway.js';
import { systemActor } from '../../lib/auth-context.js';
import { GitProviderError } from '../../lib/git-provider.js';
import { ProblemError } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { getConnection, providerFor } from '../github/providers.js';
import { nodes } from '../nodes/schema.js';
import { createSettingsService } from '../settings/service.js';
import { auditCopy, COPYABLE_TRIGGERS, copyOf, findCopySource } from './copies.js';
import {
  announceStatus,
  type CheckRunRow,
  checkNodeState,
  NODE_OFFLINE_MESSAGE,
  UNSUPPORTED_AGENT_MESSAGE,
} from './model.js';
import { buildCheckRunPayload } from './payload.js';
import { checkRuns } from './schema.js';

export const NODE_TIMEOUT_MESSAGE = 'Timed out waiting for the node';
/** Runs a dispatch pass tries after errors before it leaves the rest to the next pass. */
const MAX_DISPATCH_ATTEMPTS = 10;

type AppRow = typeof apps.$inferSelect;
/**
 * `sent`: a slot of the node is taken, the next queued run may take another; `errored` and
 * `copied`: the slot is still free, so the next queued run may go.
 */
type DispatchOutcome = 'none' | 'sent' | 'errored' | 'deferred' | 'copied';
type Claim = { run: CheckRunRow; app: AppRow } | { copied: CheckRunRow };

export interface CheckDispatcher {
  /**
   * Sends the oldest queued runs of the node to its agent, one after the other, while fewer than
   * the platform's `checkConcurrency` run there and the node is online. A run that cannot be sent
   * is errored and the next one tried. Never throws; failures are logged.
   */
  dispatchNode(nodeId: NodeId): Promise<void>;
  /**
   * One worker pass: errors runs left by their node (queued while the node has been offline for
   * QUEUED_CHECK_TIMEOUT_MS, or running on a node gone that long), then dispatches for every
   * online node with queued runs.
   */
  tick(now?: Date): Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof ProblemError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : 'unknown error';
}

export function createCheckDispatcher(deps: Deps): CheckDispatcher {
  const logger = deps.logger.child({ component: 'check-dispatcher' });
  const settings = createSettingsService(deps);
  const actor = systemActor('check-dispatcher');
  const state = checkNodeState(deps.events);

  /**
   * Marks the oldest queued run of the node `running` while fewer than `limit` run there, or ends
   * it as a copy when a run of the same tree and check finished meanwhile (same-tree copies).
   * Claims of one node take turns on a transaction-level advisory lock of the node, so each one
   * counts the runs the claims before it committed (ADR 0021). The claim waits for a row another
   * statement holds for a moment (the commit status mirror, a cancel) instead of skipping it, so
   * the oldest run goes first.
   */
  async function claim(nodeId: NodeId, limit: number): Promise<Claim | null> {
    return deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('launchway.checks.node:' || ${nodeId}))`,
      );
      const [running] = await tx
        .select({ count: count() })
        .from(checkRuns)
        .where(and(eq(checkRuns.nodeId, nodeId), eq(checkRuns.status, 'running')));
      if ((running?.count ?? 0) >= limit) return null;
      const [next] = await tx
        .select()
        .from(checkRuns)
        .where(and(eq(checkRuns.nodeId, nodeId), eq(checkRuns.status, 'queued')))
        .orderBy(asc(checkRuns.createdAt), asc(checkRuns.id))
        .limit(1)
        .for('update');
      if (!next) return null;
      if ((COPYABLE_TRIGGERS as readonly string[]).includes(next.trigger)) {
        const source = await findCopySource(tx, next);
        if (source) {
          const [copied] = await tx
            .update(checkRuns)
            .set(copyOf(source))
            .where(and(eq(checkRuns.id, next.id), eq(checkRuns.status, 'queued')))
            .returning();
          if (!copied) return null;
          await auditCopy(tx, actor, copied, 'queued');
          return { copied };
        }
      }
      const [run] = await tx
        .update(checkRuns)
        .set({ status: 'running', startedAt: new Date() })
        .where(and(eq(checkRuns.id, next.id), eq(checkRuns.status, 'queued')))
        .returning();
      if (!run) return null;
      const [app] = await tx.select().from(apps).where(eq(apps.id, run.appId));
      if (!app) throw new Error('the app of a check run is missing');
      return { run, app };
    });
  }

  /** Errors a queued or running run (audited); false when its status changed meanwhile. */
  async function fail(
    run: CheckRunRow,
    from: 'queued' | 'running',
    reason: CheckRunReason,
    message: string,
  ): Promise<boolean> {
    const updated = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(checkRuns)
        .set({ status: 'errored', reason, statusMessage: message, finishedAt: new Date() })
        .where(and(eq(checkRuns.id, run.id), eq(checkRuns.status, from)))
        .returning();
      if (row) {
        await recordAudit(tx, actor, {
          action: 'check.error',
          target: { type: 'check', id: run.id },
          summary: {
            appId: run.appId,
            name: run.name,
            status: { from, to: 'errored' },
            reason,
          },
        });
      }
      return row;
    });
    if (!updated) return false;
    announceStatus(deps, updated);
    return true;
  }

  /** Puts a claimed run back in the queue: the node or GitHub was briefly unavailable. */
  async function release(run: CheckRunRow): Promise<void> {
    const [row] = await deps.db
      .update(checkRuns)
      .set({ status: 'queued', startedAt: null })
      .where(and(eq(checkRuns.id, run.id), eq(checkRuns.status, 'running')))
      .returning();
    if (row) announceStatus(deps, row);
  }

  async function payloadFor(app: AppRow, run: CheckRunRow) {
    const connection = await getConnection(deps.db, app.connectionId);
    // A fresh credential per run; for GitHub Apps `contents: read` on this repository only.
    const clone = await providerFor(deps, connection).cloneCredentials(app.repoOwner, app.repoName);
    return buildCheckRunPayload({ run, app, clone, limits: await settings.get() });
  }

  /** Errors the queued runs of a node whose agent does not run checks: nothing would run them. */
  async function failUnsupported(nodeId: NodeId): Promise<void> {
    const queued = await deps.db
      .select()
      .from(checkRuns)
      .where(and(eq(checkRuns.nodeId, nodeId), eq(checkRuns.status, 'queued')));
    for (const run of queued) await fail(run, 'queued', 'unsupported', UNSUPPORTED_AGENT_MESSAGE);
    if (queued.length > 0) {
      logger.warn({ nodeId, count: queued.length }, 'the agent of the node does not run checks');
    }
  }

  async function dispatchOnce(nodeId: NodeId, limit: number): Promise<DispatchOutcome> {
    if (!deps.agents.isOnline(nodeId)) return 'none';
    if (state.capable.get(nodeId) === false) {
      await failUnsupported(nodeId);
      return 'none';
    }
    const claimed = await claim(nodeId, limit);
    if (!claimed) return 'none';
    if ('copied' in claimed) {
      announceStatus(deps, claimed.copied);
      logger.info(
        { nodeId, runId: claimed.copied.id, copiedFrom: claimed.copied.copiedFromId },
        'check run reused the result of a run of the same tree',
      );
      return 'copied';
    }
    const { run, app } = claimed;
    announceStatus(deps, run);
    const context = { nodeId, appId: run.appId, runId: run.id, check: run.name };
    try {
      await deps.agents.runCheck(nodeId, await payloadFor(app, run));
    } catch (error) {
      if (error instanceof AgentRequestError && error.code === 'timeout') {
        if (state.capable.get(nodeId) === false) {
          await fail(run, 'running', 'unsupported', UNSUPPORTED_AGENT_MESSAGE);
          return 'errored';
        }
        // The answer may be lost on a dropped link, or the agent may be older than checks: keep
        // the claim until heartbeats tell. The sink sends the run again if the agent lacks it,
        // and errors it as unsupported if the heartbeats show an agent without checks.
        state.unacknowledged.add(run.id);
        logger.warn(context, 'the agent did not acknowledge a check run in time');
        return 'sent';
      }
      const transient =
        error instanceof AgentUnavailableError ||
        (error instanceof GitProviderError && error.kind === 'upstream');
      if (transient) {
        logger.warn({ ...context, reason: messageOf(error) }, 'check dispatch deferred');
        await release(run);
        return 'deferred';
      }
      const reason = messageOf(error);
      logger.warn({ ...context, reason }, 'check dispatch failed');
      await fail(run, 'running', 'dispatch', `Dispatch failed: ${reason}`);
      return 'errored';
    }
    logger.info(context, 'check run dispatched');
    return 'sent';
  }

  async function dispatchNode(nodeId: NodeId): Promise<void> {
    try {
      if (!deps.agents.isOnline(nodeId)) return;
      const { checkConcurrency } = await settings.get();
      // Until the node is full or nothing waits: a sent run takes a slot, and an errored or
      // copied one leaves it for the next queued run (those count against the attempts).
      for (let attempts = 0; attempts < MAX_DISPATCH_ATTEMPTS; ) {
        const outcome = await dispatchOnce(nodeId, checkConcurrency);
        if (outcome === 'none' || outcome === 'deferred') return;
        if (outcome !== 'sent') attempts += 1;
      }
    } catch (error) {
      logger.error({ err: error, nodeId }, 'check dispatch errored');
    }
  }

  return {
    dispatchNode,

    async tick(now = new Date()) {
      // Only nodes gone for the whole timeout: waiting behind other checks is not stale.
      const cutoff = new Date(now.getTime() - QUEUED_CHECK_TIMEOUT_MS);
      const gone = or(isNull(nodes.lastSeenAt), lt(nodes.lastSeenAt, cutoff));
      const stale = await deps.db
        .select({ run: checkRuns })
        .from(checkRuns)
        .innerJoin(nodes, eq(nodes.id, checkRuns.nodeId))
        .where(and(eq(checkRuns.status, 'queued'), lt(checkRuns.createdAt, cutoff), gone));
      for (const { run } of stale) {
        if (deps.agents.isOnline(run.nodeId)) continue;
        await fail(run, 'queued', 'offline', NODE_TIMEOUT_MESSAGE);
      }
      // Safety net: the node's offline report normally settles these (a restart may lose it).
      const abandoned = await deps.db
        .select({ run: checkRuns })
        .from(checkRuns)
        .innerJoin(nodes, eq(nodes.id, checkRuns.nodeId))
        .where(and(eq(checkRuns.status, 'running'), gone));
      for (const { run } of abandoned) {
        if (deps.agents.isOnline(run.nodeId)) continue;
        await fail(run, 'running', 'offline', NODE_OFFLINE_MESSAGE);
      }

      const waiting = await deps.db
        .selectDistinct({ nodeId: checkRuns.nodeId })
        .from(checkRuns)
        .where(eq(checkRuns.status, 'queued'));
      for (const { nodeId } of waiting) {
        if (deps.agents.isOnline(nodeId)) await dispatchNode(nodeId);
      }
    },
  };
}
