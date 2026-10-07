import {
  type AppId,
  type CreateDeploymentInput,
  type Deployment,
  type DeploymentId,
  type DeploymentListQuery,
  type DeploymentLogsQuery,
  type DeploymentPage,
  type DeploymentTrigger,
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  isInProgressStatus,
  type ServiceStatus,
  SSE_EVENTS,
} from '@launchway/contracts';
import { and, asc, desc, eq, gt, inArray, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.js';
import type { Deps } from '../../deps.js';
import { AgentRequestError, AgentUnavailableError } from '../../lib/agent-gateway.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { GitProviderError } from '../../lib/git-provider.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { conflict, invalidField, notFound, ProblemError } from '../../lib/problem.js';
import type { SseMessage } from '../../lib/sse.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { getConnection, providerFor, toGitProblem } from '../github/providers.js';
import { createDispatcher } from './dispatcher.js';
import { type DeploymentStreamItem, logHubFor } from './log-hub.js';
import { announceStatus, type DeploymentRow, toDeployment } from './model.js';
import { deploymentLogLines, deployments } from './schema.js';

type AppRow = typeof apps.$inferSelect;

const ListCursor = z.object({ t: z.iso.datetime(), i: z.string().min(1).max(64) });
const HISTORY_BATCH = 1000;
const MAX_BUFFERED_ITEMS = 10_000;

export interface DeploymentsService {
  create(appId: AppId, input: CreateDeploymentInput, actor: RequestActor): Promise<Deployment>;
  /**
   * Deploys a release tag for an app with `autoDeployReleases`; skipped (null) when a deployment
   * of that ref already exists for the app.
   */
  createForRelease(app: AppRow, tag: string, actor: RequestActor): Promise<Deployment | null>;
  /**
   * Deploys a pushed commit of the app's `autoDeployBranch` (ref = the branch, commit = the
   * pushed SHA); skipped (null) when a deployment of that commit already exists for the app.
   */
  createForPush(
    app: AppRow,
    branch: string,
    commitSha: string,
    actor: RequestActor,
  ): Promise<Deployment | null>;
  list(appId: AppId, query: DeploymentListQuery): Promise<DeploymentPage>;
  get(id: DeploymentId): Promise<Deployment>;
  cancel(id: DeploymentId, actor: RequestActor): Promise<Deployment>;
  /** SSE source of `GET /deployments/{id}/logs`: history, then live lines while in progress. */
  logStream(
    id: DeploymentId,
    query: DeploymentLogsQuery,
    signal: AbortSignal,
  ): AsyncIterable<SseMessage>;
}

/**
 * Marks the running deployment of an app `stopped` (after `compose stop`). Runs inside the
 * caller's transaction; returns the stopped row, if any.
 * @public
 */
export async function markRunningStopped(
  tx: Executor,
  appId: AppId,
  services: ServiceStatus[],
): Promise<DeploymentRow | undefined> {
  const [row] = await tx
    .update(deployments)
    .set({ status: 'stopped', services, finishedAt: new Date() })
    .where(and(eq(deployments.appId, appId), eq(deployments.status, 'running')))
    .returning();
  return row;
}

/** The running deployment of an app (read-only helper for the apps module). */
export async function findRunningDeployment(
  db: Executor,
  appId: AppId,
): Promise<DeploymentRow | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.appId, appId), eq(deployments.status, 'running')));
  return row;
}

export function createDeploymentsService(deps: Deps): DeploymentsService {
  const dispatcher = createDispatcher(deps);
  const hub = logHubFor(deps.events);

  async function loadApp(appId: AppId): Promise<AppRow> {
    const [app] = await deps.db.select().from(apps).where(eq(apps.id, appId));
    if (!app) throw notFound('App not found');
    return app;
  }

  async function loadRow(id: DeploymentId): Promise<DeploymentRow> {
    const [row] = await deps.db.select().from(deployments).where(eq(deployments.id, id));
    if (!row) throw notFound('Deployment not found');
    return row;
  }

  interface InsertOptions {
    /** `background`: do not wait for the agent's acknowledgement (webhook deliveries). */
    dispatch?: 'await' | 'background';
    /** Known commit (push events); skips resolving the ref. */
    commitSha?: string;
    /**
     * Skip the insert when a deployment of the app matches (checked under the app row lock, so
     * concurrent deliveries of the same release or push create one deployment).
     */
    unlessExists?: SQL;
  }

  function insert(
    app: AppRow,
    ref: string,
    trigger: DeploymentTrigger,
    actor: RequestActor,
    options?: InsertOptions & { unlessExists?: undefined },
  ): Promise<Deployment>;
  function insert(
    app: AppRow,
    ref: string,
    trigger: DeploymentTrigger,
    actor: RequestActor,
    options: InsertOptions,
  ): Promise<Deployment | null>;
  async function insert(
    app: AppRow,
    ref: string,
    trigger: DeploymentTrigger,
    actor: RequestActor,
    options: InsertOptions = {},
  ): Promise<Deployment | null> {
    const dispatch = options.dispatch ?? 'await';
    let commitSha: string;
    if (options.commitSha) {
      commitSha = options.commitSha;
    } else {
      const connection = await getConnection(deps.db, app.connectionId);
      try {
        ({ sha: commitSha } = await providerFor(deps, connection).resolveRef(
          app.repoOwner,
          app.repoName,
          ref,
        ));
      } catch (error) {
        if (error instanceof GitProviderError && error.kind === 'not-found') {
          throw invalidField('body.ref', `Ref not found in ${app.repoOwner}/${app.repoName}`);
        }
        throw toGitProblem(error);
      }
    }

    const row = await deps.db.transaction(async (tx) => {
      if (options.unlessExists) {
        await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, app.id)).for('update');
        const [existing] = await tx
          .select({ id: deployments.id })
          .from(deployments)
          .where(and(eq(deployments.appId, app.id), options.unlessExists))
          .limit(1);
        if (existing) return null;
      }
      const [created] = await tx
        .insert(deployments)
        .values({
          appId: app.id,
          nodeId: app.nodeId,
          ref,
          commitSha,
          trigger,
          triggeredById: actor.principal?.user.id ?? null,
          createdAt: new Date(),
        })
        .returning();
      if (!created) throw new Error('insert returned no row');
      await recordAudit(tx, actor, {
        action: 'deployment.create',
        target: { type: 'deployment', id: created.id },
        summary: { appId: app.id, ref, commitSha, trigger },
      });
      return created;
    });
    if (!row) return null;
    deps.events.publish({
      topic: 'deployments',
      action: 'created',
      resourceId: row.id,
      data: { appId: app.id, status: row.status },
    });
    deps.logger.info({ deploymentId: row.id, appId: app.id, trigger }, 'deployment queued');
    if (dispatch === 'background') {
      void dispatcher.dispatchApp(app.id);
      return toDeployment(row);
    }
    await dispatcher.dispatchApp(app.id);
    return toDeployment(await loadRow(row.id));
  }

  async function cancelLocally(row: DeploymentRow, actor: RequestActor): Promise<Deployment> {
    const updated = await deps.db.transaction(async (tx) => {
      const [changed] = await tx
        .update(deployments)
        .set({ status: 'cancelled', statusMessage: 'Cancelled', finishedAt: new Date() })
        .where(and(eq(deployments.id, row.id), eq(deployments.status, row.status)))
        .returning();
      if (!changed) throw conflict('The deployment changed meanwhile; try again');
      await recordAudit(tx, actor, {
        action: 'deployment.cancel',
        target: { type: 'deployment', id: row.id },
        summary: { appId: row.appId, status: { from: row.status, to: 'cancelled' } },
      });
      return changed;
    });
    announceStatus(deps, updated, true);
    await dispatcher.dispatchApp(row.appId);
    return toDeployment(updated);
  }

  return {
    async create(appId, input, actor) {
      return insert(await loadApp(appId), input.ref, 'manual', actor);
    },

    async createForRelease(app, tag, actor) {
      const [existing] = await deps.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.appId, app.id), eq(deployments.ref, tag)))
        .limit(1);
      if (existing) return null;
      return insert(app, tag, 'auto', actor, {
        dispatch: 'background',
        unlessExists: eq(deployments.ref, tag),
      });
    },

    async createForPush(app, branch, commitSha, actor) {
      return insert(app, branch, 'auto', actor, {
        dispatch: 'background',
        commitSha,
        unlessExists: eq(deployments.commitSha, commitSha),
      });
    },

    async list(appId, query) {
      await loadApp(appId);
      const conditions: SQL[] = [eq(deployments.appId, appId)];
      if (query.status) conditions.push(eq(deployments.status, query.status));
      if (query.cursor) {
        const position = decodeCursor(query.cursor, ListCursor);
        const t = new Date(position.t);
        const keyset = or(
          lt(deployments.createdAt, t),
          and(eq(deployments.createdAt, t), lt(deployments.id, position.i as DeploymentId)),
        );
        if (keyset) conditions.push(keyset);
      }
      const rows = await deps.db
        .select()
        .from(deployments)
        .where(and(...conditions))
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map(toDeployment),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id })
            : null,
      };
    },

    async get(id) {
      return toDeployment(await loadRow(id));
    },

    async cancel(id, actor) {
      const row = await loadRow(id);
      if (!isInProgressStatus(row.status)) {
        throw conflict(
          `The deployment is ${row.status}; only queued or in-progress deployments can be cancelled`,
        );
      }
      if (row.status === 'queued' && row.startedAt === null) return cancelLocally(row, actor);
      try {
        await deps.agents.cancelDeployment(row.nodeId, row.id);
      } catch (error) {
        // The agent is gone or does not know the deployment, so nothing runs it any more.
        if (
          error instanceof AgentUnavailableError ||
          (error instanceof AgentRequestError && error.code === 'not-found')
        ) {
          return cancelLocally(row, actor);
        }
        throw new ProblemError('upstream-failed', {
          detail: 'The node did not confirm the cancellation',
          cause: error,
        });
      }
      const changed = await deps.db.transaction(async (tx) => {
        // The agent's result may have landed already: only annotate a deployment still running.
        const [annotated] = await tx
          .update(deployments)
          .set({ statusMessage: 'Cancellation requested' })
          .where(
            and(
              eq(deployments.id, row.id),
              inArray(deployments.status, IN_PROGRESS_DEPLOYMENT_STATUSES),
            ),
          )
          .returning();
        await recordAudit(tx, actor, {
          action: 'deployment.cancel',
          target: { type: 'deployment', id: row.id },
          summary: { appId: row.appId, requested: true, status: row.status },
        });
        return annotated;
      });
      if (!changed) return toDeployment(await loadRow(id));
      deps.events.publish({
        topic: 'deployments',
        action: 'updated',
        resourceId: row.id,
        data: { appId: row.appId, status: changed.status },
      });
      return toDeployment(changed);
    },

    async *logStream(id, query, signal) {
      const queue: DeploymentStreamItem[] = [];
      let wake: (() => void) | undefined;
      const onAbort = () => wake?.();
      signal.addEventListener('abort', onAbort);
      // Subscribe before reading history so nothing falls between the two; seq dedupes.
      const unsubscribe = query.follow
        ? hub.subscribe(id, (item) => {
            queue.push(item);
            if (queue.length > MAX_BUFFERED_ITEMS) queue.shift();
            wake?.();
          })
        : () => {};
      let last = query.after ?? -1;
      async function* history(): AsyncGenerator<SseMessage> {
        for (;;) {
          const rows = await deps.db
            .select()
            .from(deploymentLogLines)
            .where(and(eq(deploymentLogLines.deploymentId, id), gt(deploymentLogLines.seq, last)))
            .orderBy(asc(deploymentLogLines.seq))
            .limit(HISTORY_BATCH);
          for (const row of rows) {
            if (signal.aborted) return;
            last = row.seq;
            yield {
              event: SSE_EVENTS.log,
              id: String(row.seq),
              data: {
                seq: row.seq,
                timestamp: row.loggedAt.toISOString(),
                stream: row.stream,
                line: row.line,
              },
            };
          }
          if (rows.length < HISTORY_BATCH) break;
        }
      }
      try {
        yield* history();
        if (signal.aborted) return;
        const current = await loadRow(id);
        if (!query.follow || !isInProgressStatus(current.status)) {
          // Lines stored between the history read and the status check (the final ones).
          yield* history();
          if (signal.aborted) return;
          yield { event: SSE_EVENTS.end, data: { status: current.status } };
          return;
        }
        while (!signal.aborted) {
          const item = queue.shift();
          if (!item) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            continue;
          }
          if (item.kind === 'log') {
            if (item.line.seq <= last) continue;
            last = item.line.seq;
            yield { event: SSE_EVENTS.log, id: String(item.line.seq), data: item.line };
          } else if (item.kind === 'status') {
            yield { event: SSE_EVENTS.status, data: { status: item.status } };
          } else {
            yield { event: SSE_EVENTS.end, data: { status: item.status } };
            return;
          }
        }
      } finally {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
