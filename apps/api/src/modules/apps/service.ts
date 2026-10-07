import {
  type App,
  type AppId,
  type AppListQuery,
  type AppLogLine,
  type AppLogsQuery,
  type AppPage,
  type AppRuntimeStatus,
  AppSlug,
  type CreateAppInput,
  DEFAULT_COMPOSE_FILES,
  type DeleteAppQuery,
  type EnvVar,
  type EnvVarList,
  maskEnvVar,
  roleAtLeast,
  type SetEnvVarsInput,
  SSE_EVENTS,
  type UpdateAppInput,
  type UpdateEnvVarInput,
} from '@launchway/contracts';
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import {
  AgentUnavailableError,
  type AppTarget,
  type LogsRequest,
} from '../../lib/agent-gateway.js';
import { effectiveRole, getActorPrincipal, type RequestActor } from '../../lib/auth-context.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { conflict, forbidden, invalidField, notFound, ProblemError } from '../../lib/problem.js';
import type { SseMessage } from '../../lib/sse.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { announceStatus } from '../deployments/model.js';
import { deployments } from '../deployments/schema.js';
import { findRunningDeployment, markRunningStopped } from '../deployments/service.js';
import { githubConnections } from '../github/schema.js';
import { nodes } from '../nodes/schema.js';
import { envContext } from './env.js';
import { apps, envVars } from './schema.js';

type AppRow = typeof apps.$inferSelect;
type EnvVarRow = typeof envVars.$inferSelect;

const ListCursor = z.object({ t: z.iso.datetime(), i: z.string().min(1).max(64) });
const PENDING_STATUSES = ['queued', 'cloning', 'building', 'starting'] as const;
const MAX_BUFFERED_LINES = 5000;

/** URL-safe slug from a display name (`My App!` -> `my-app`); null when nothing usable is left. */
export function deriveSlug(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return AppSlug.safeParse(slug).success ? slug : null;
}

function toApp(row: AppRow, activeDeploymentId: App['activeDeploymentId']): App {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    connectionId: row.connectionId,
    repository: { owner: row.repoOwner, name: row.repoName },
    composeFiles: row.composeFiles,
    dockerfile: row.dockerfile,
    context: row.context,
    nodeId: row.nodeId,
    autoDeployReleases: row.autoDeployReleases,
    trustedMounts: row.trustedMounts,
    activeDeploymentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEnvVar(row: EnvVarRow, value: string): EnvVar {
  return maskEnvVar({
    id: row.id,
    key: row.key,
    secret: row.secret,
    value,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Trusted mounts are an explicit admin decision (ADR 0015): members may edit everything else of
 * an app, but turning `trustedMounts` on or off needs the admin role.
 */
function assertMayChangeTrustedMounts(actor: RequestActor): void {
  if (!roleAtLeast(effectiveRole(getActorPrincipal(actor)), 'admin')) {
    throw forbidden(
      'Only an admin can change trustedMounts: trusted apps may bind-mount host directories and reuse foreign volumes',
    );
  }
}

export interface AppsService {
  create(input: CreateAppInput, actor: RequestActor): Promise<App>;
  list(query: AppListQuery): Promise<AppPage>;
  get(id: AppId): Promise<App>;
  update(id: AppId, input: UpdateAppInput, actor: RequestActor): Promise<App>;
  remove(id: AppId, query: DeleteAppQuery, actor: RequestActor): Promise<void>;
  listEnv(id: AppId): Promise<EnvVarList>;
  replaceEnv(id: AppId, input: SetEnvVarsInput, actor: RequestActor): Promise<EnvVarList>;
  setEnv(id: AppId, key: string, input: UpdateEnvVarInput, actor: RequestActor): Promise<EnvVar>;
  deleteEnv(id: AppId, key: string, actor: RequestActor): Promise<void>;
  status(id: AppId): Promise<AppRuntimeStatus>;
  stop(id: AppId, actor: RequestActor): Promise<AppRuntimeStatus>;
  /** Fails with 503 before streaming when the node is offline. */
  openLogs(
    id: AppId,
    query: AppLogsQuery,
  ): Promise<(signal: AbortSignal) => AsyncIterable<SseMessage>>;
}

export function createAppsService(deps: Deps): AppsService {
  async function loadRow(db: Executor, id: AppId, forUpdate = false): Promise<AppRow> {
    const query = db.select().from(apps).where(eq(apps.id, id));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('App not found');
    return row;
  }

  /**
   * Cancels the app's queued deployments that were not sent yet, under the app row lock that
   * dispatching takes, so none of them goes out after a stop or delete (the result of the
   * deployment being cancelled would otherwise dispatch the next one).
   */
  async function cancelUnsent(id: AppId, actor: RequestActor, reason: string): Promise<void> {
    const cancelled = await deps.db.transaction(async (tx) => {
      await loadRow(tx, id, true);
      const rows = await tx
        .update(deployments)
        .set({ status: 'cancelled', statusMessage: reason, finishedAt: new Date() })
        .where(
          and(
            eq(deployments.appId, id),
            eq(deployments.status, 'queued'),
            isNull(deployments.startedAt),
          ),
        )
        .returning();
      for (const row of rows) {
        await recordAudit(tx, actor, {
          action: 'deployment.cancel',
          target: { type: 'deployment', id: row.id },
          summary: { appId: id, reason },
        });
      }
      return rows;
    });
    for (const row of cancelled) announceStatus(deps, row, true);
  }

  async function activeDeploymentId(db: Executor, id: AppId) {
    return (await findRunningDeployment(db, id))?.id ?? null;
  }

  async function assertReferences(
    db: Executor,
    input: { connectionId?: string | undefined; nodeId?: string | undefined },
  ): Promise<void> {
    if (input.connectionId !== undefined) {
      const [connection] = await db
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.id, input.connectionId as AppRow['connectionId']));
      if (!connection) throw invalidField('body.connectionId', 'Unknown GitHub connection');
    }
    if (input.nodeId !== undefined) {
      const [node] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, input.nodeId as AppRow['nodeId']));
      if (!node) throw invalidField('body.nodeId', 'Unknown node');
    }
  }

  function mapWriteError(error: unknown): unknown {
    if (isUniqueViolation(error)) return conflict('An app with this slug already exists');
    if (isForeignKeyViolation(error)) {
      return invalidField('body', 'The GitHub connection or node does not exist');
    }
    return error;
  }

  function signalRedeploy(appId: AppId, reason: string): void {
    deps.events.publish({
      topic: 'apps',
      action: 'updated',
      resourceId: appId,
      data: { redeployRequired: true, reason },
    });
  }

  async function envMutation<T>(
    appId: AppId,
    work: (tx: Executor, app: AppRow) => Promise<T>,
  ): Promise<T> {
    const result = await deps.db.transaction(async (tx) =>
      work(tx, await loadRow(tx, appId, true)),
    );
    deps.events.publish({ topic: 'env', action: 'updated', resourceId: appId });
    signalRedeploy(appId, 'env');
    return result;
  }

  function decryptRow(row: EnvVarRow): string {
    return deps.secrets.decrypt(row.valueEncrypted, envContext(row.appId, row.key));
  }

  async function envList(db: Executor, appId: AppId): Promise<EnvVarList> {
    const rows = await db
      .select()
      .from(envVars)
      .where(eq(envVars.appId, appId))
      .orderBy(asc(envVars.key));
    return { items: rows.map((row) => toEnvVar(row, row.secret ? '' : decryptRow(row))) };
  }

  async function lastKnownStatus(app: AppRow, nodeOnline: boolean): Promise<AppRuntimeStatus> {
    const running = await findRunningDeployment(deps.db, app.id);
    return {
      appId: app.id,
      nodeId: app.nodeId,
      nodeOnline,
      source: 'last-deployment',
      activeDeploymentId: running?.id ?? null,
      services: running?.services ?? [],
    };
  }

  const target = (app: AppRow): AppTarget => ({ id: app.id, slug: app.slug });

  return {
    async create(input, actor) {
      const slug = input.slug ?? deriveSlug(input.name);
      if (!slug) throw invalidField('body.slug', 'Cannot derive a slug from the name; provide one');
      if (input.trustedMounts) assertMayChangeTrustedMounts(actor);
      await assertReferences(deps.db, input);
      const usesDockerfile = input.dockerfile !== undefined;
      let row: AppRow;
      try {
        row = await deps.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(apps)
            .values({
              slug,
              name: input.name,
              description: input.description ?? null,
              connectionId: input.connectionId,
              repoOwner: input.repository.owner,
              repoName: input.repository.name,
              composeFiles: usesDockerfile
                ? null
                : [...(input.composeFiles ?? DEFAULT_COMPOSE_FILES)],
              dockerfile: input.dockerfile ?? null,
              context: usesDockerfile ? (input.context ?? '.') : null,
              nodeId: input.nodeId,
              autoDeployReleases: input.autoDeployReleases,
              trustedMounts: input.trustedMounts,
              createdAt: new Date(),
            })
            .returning();
          if (!created) throw new Error('insert returned no row');
          await recordAudit(tx, actor, {
            action: 'app.create',
            target: { type: 'app', id: created.id },
            summary: {
              slug,
              repository: `${created.repoOwner}/${created.repoName}`,
              nodeId: created.nodeId,
              trustedMounts: created.trustedMounts,
            },
          });
          return created;
        });
      } catch (error) {
        throw mapWriteError(error);
      }
      deps.events.publish({ topic: 'apps', action: 'created', resourceId: row.id });
      return toApp(row, null);
    },

    async list(query) {
      const conditions: SQL[] = [];
      if (query.nodeId) conditions.push(eq(apps.nodeId, query.nodeId));
      if (query.cursor) {
        const position = decodeCursor(query.cursor, ListCursor);
        const t = new Date(position.t);
        const keyset = or(
          lt(apps.createdAt, t),
          and(eq(apps.createdAt, t), lt(apps.id, position.i as AppId)),
        );
        if (keyset) conditions.push(keyset);
      }
      const rows = await deps.db
        .select({ app: apps, activeDeploymentId: deployments.id })
        .from(apps)
        .leftJoin(
          deployments,
          and(eq(deployments.appId, apps.id), eq(deployments.status, 'running')),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(apps.createdAt), desc(apps.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1)?.app;
      return {
        items: items.map((r) => toApp(r.app, r.activeDeploymentId)),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id })
            : null,
      };
    },

    async get(id) {
      const row = await loadRow(deps.db, id);
      return toApp(row, await activeDeploymentId(deps.db, id));
    },

    async update(id, input, actor) {
      if (input.trustedMounts !== undefined) assertMayChangeTrustedMounts(actor);
      await assertReferences(deps.db, input);
      const patch: Partial<AppRow> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.connectionId !== undefined) patch.connectionId = input.connectionId;
      if (input.nodeId !== undefined) patch.nodeId = input.nodeId;
      if (input.autoDeployReleases !== undefined) {
        patch.autoDeployReleases = input.autoDeployReleases;
      }
      if (input.trustedMounts !== undefined) patch.trustedMounts = input.trustedMounts;
      if (input.composeFiles !== undefined) {
        Object.assign(patch, { composeFiles: input.composeFiles, dockerfile: null, context: null });
      } else if (input.dockerfile !== undefined) {
        Object.assign(patch, {
          composeFiles: null,
          dockerfile: input.dockerfile,
          context: input.context ?? '.',
        });
      }

      let result: { before: AppRow; after: AppRow; active: App['activeDeploymentId'] };
      try {
        result = await deps.db.transaction(async (tx) => {
          const before = await loadRow(tx, id, true);
          if (patch.nodeId !== undefined && patch.nodeId !== before.nodeId) {
            const [busy] = await tx
              .select({ id: deployments.id })
              .from(deployments)
              .where(
                and(
                  eq(deployments.appId, id),
                  inArray(deployments.status, [...PENDING_STATUSES, 'running']),
                ),
              )
              .limit(1);
            if (busy) {
              throw conflict(
                'The app has a running or pending deployment on its node; stop it before moving the app',
              );
            }
          }
          const [after] = await tx.update(apps).set(patch).where(eq(apps.id, id)).returning();
          if (!after) throw notFound('App not found');
          await recordAudit(tx, actor, {
            action: 'app.update',
            target: { type: 'app', id },
            summary: diffSummary(before, after, Object.keys(patch)),
          });
          return { before, after, active: await activeDeploymentId(tx, id) };
        });
      } catch (error) {
        throw mapWriteError(error);
      }
      deps.events.publish({ topic: 'apps', action: 'updated', resourceId: id });
      const runtimeKeys = [
        'composeFiles',
        'dockerfile',
        'context',
        'connectionId',
        'trustedMounts',
      ] as const;
      if (runtimeKeys.some((key) => key in patch) && result.active) signalRedeploy(id, 'source');
      return toApp(result.after, result.active);
    },

    async remove(id, query, actor) {
      const app = await loadRow(deps.db, id);
      await cancelUnsent(id, actor, 'Cancelled: the app is being deleted');
      const pending = await deps.db
        .select({
          id: deployments.id,
          status: deployments.status,
          startedAt: deployments.startedAt,
        })
        .from(deployments)
        .where(and(eq(deployments.appId, id), inArray(deployments.status, PENDING_STATUSES)));
      let nodeOnline = deps.agents.isOnline(app.nodeId);
      if (nodeOnline) {
        for (const deployment of pending) {
          if (deployment.status === 'queued' && deployment.startedAt === null) continue;
          await deps.agents.cancelDeployment(app.nodeId, deployment.id).catch(() => {});
        }
        try {
          await deps.agents.removeApp(app.nodeId, target(app), query.removeVolumes);
        } catch (error) {
          if (!(error instanceof AgentUnavailableError)) {
            throw new ProblemError('upstream-failed', {
              detail: 'The node could not remove the app',
              cause: error,
            });
          }
          nodeOnline = false;
        }
      }
      if (!nodeOnline && !query.force) {
        throw conflict(
          'The node of this app is offline, so its containers cannot be removed; retry with force=true to delete it anyway',
        );
      }
      await deps.db.transaction(async (tx) => {
        await tx.delete(apps).where(eq(apps.id, id));
        await recordAudit(tx, actor, {
          action: 'app.delete',
          target: { type: 'app', id },
          summary: {
            slug: app.slug,
            removedFromNode: nodeOnline,
            removeVolumes: query.removeVolumes,
          },
        });
      });
      deps.events.publish({ topic: 'apps', action: 'deleted', resourceId: id });
    },

    async listEnv(id) {
      await loadRow(deps.db, id);
      return envList(deps.db, id);
    },

    async replaceEnv(id, input, actor) {
      return envMutation(id, async (tx) => {
        const existing = new Map(
          (await tx.select().from(envVars).where(eq(envVars.appId, id))).map((r) => [r.key, r]),
        );
        const added: string[] = [];
        const changed: string[] = [];
        for (const [index, variable] of input.variables.entries()) {
          const current = existing.get(variable.key);
          existing.delete(variable.key);
          if (!current) {
            if (variable.value === undefined) {
              throw invalidField(`body.variables.${index}.value`, 'Required for a new variable');
            }
            await tx.insert(envVars).values({
              appId: id,
              key: variable.key,
              secret: variable.secret,
              valueEncrypted: deps.secrets.encrypt(variable.value, envContext(id, variable.key)),
            });
            added.push(variable.key);
            continue;
          }
          const valueChanged =
            variable.value !== undefined && variable.value !== decryptRow(current);
          if (!valueChanged && variable.secret === current.secret) continue;
          if (!variable.secret && current.secret && variable.value === undefined) {
            throw invalidField(
              `body.variables.${index}.value`,
              'Provide a new value when turning a secret into a plain variable',
            );
          }
          await tx
            .update(envVars)
            .set({
              secret: variable.secret,
              ...(variable.value === undefined
                ? {}
                : {
                    valueEncrypted: deps.secrets.encrypt(
                      variable.value,
                      envContext(id, variable.key),
                    ),
                  }),
            })
            .where(eq(envVars.id, current.id));
          changed.push(variable.key);
        }
        const removed = [...existing.keys()];
        if (removed.length > 0) {
          await tx.delete(envVars).where(and(eq(envVars.appId, id), inArray(envVars.key, removed)));
        }
        await recordAudit(tx, actor, {
          action: 'env.replace',
          target: { type: 'app', id },
          summary: { added, changed, removed },
        });
        return envList(tx, id);
      });
    },

    async setEnv(id, key, input, actor) {
      return envMutation(id, async (tx) => {
        const [current] = await tx
          .select()
          .from(envVars)
          .where(and(eq(envVars.appId, id), eq(envVars.key, key)));
        if (!current && input.value === undefined) {
          throw invalidField('body.value', 'Required for a new variable');
        }
        const secret = input.secret ?? current?.secret ?? false;
        const valueEncrypted =
          input.value === undefined
            ? undefined
            : deps.secrets.encrypt(input.value, envContext(id, key));
        let row: EnvVarRow | undefined;
        if (current) {
          [row] = await tx
            .update(envVars)
            .set({ secret, ...(valueEncrypted === undefined ? {} : { valueEncrypted }) })
            .where(eq(envVars.id, current.id))
            .returning();
        } else {
          [row] = await tx
            .insert(envVars)
            .values({ appId: id, key, secret, valueEncrypted: valueEncrypted as string })
            .returning();
        }
        if (!row) throw new Error('env var write returned no row');
        await recordAudit(tx, actor, {
          action: 'env.set',
          target: { type: 'app', id },
          summary: {
            key,
            created: !current,
            valueChanged: input.value !== undefined,
            secret: { from: current?.secret ?? null, to: secret },
          },
        });
        return toEnvVar(row, row.secret ? '' : decryptRow(row));
      });
    },

    async deleteEnv(id, key, actor) {
      await envMutation(id, async (tx) => {
        const deleted = await tx
          .delete(envVars)
          .where(and(eq(envVars.appId, id), eq(envVars.key, key)))
          .returning({ id: envVars.id });
        if (deleted.length === 0) throw notFound('Environment variable not found');
        await recordAudit(tx, actor, {
          action: 'env.delete',
          target: { type: 'app', id },
          summary: { key },
        });
      });
    },

    async status(id) {
      const app = await loadRow(deps.db, id);
      if (!deps.agents.isOnline(app.nodeId)) return lastKnownStatus(app, false);
      try {
        const services = await deps.agents.appStatus(app.nodeId, target(app));
        return {
          appId: app.id,
          nodeId: app.nodeId,
          nodeOnline: true,
          source: 'agent',
          activeDeploymentId: await activeDeploymentId(deps.db, id),
          services,
        };
      } catch (error) {
        if (error instanceof AgentUnavailableError) return lastKnownStatus(app, false);
        throw new ProblemError('upstream-failed', {
          detail: 'The node did not report the app status',
          cause: error,
        });
      }
    },

    async stop(id, actor) {
      const app = await loadRow(deps.db, id);
      await cancelUnsent(id, actor, 'Cancelled: the app was stopped');
      let services: AppRuntimeStatus['services'];
      try {
        services = await deps.agents.stopApp(app.nodeId, target(app));
      } catch (error) {
        if (error instanceof AgentUnavailableError) {
          throw new ProblemError('service-unavailable', {
            detail: 'The node of this app is offline',
          });
        }
        throw new ProblemError('upstream-failed', {
          detail: 'The node could not stop the app',
          cause: error,
        });
      }
      const stopped = await deps.db.transaction(async (tx) => {
        const row = await markRunningStopped(tx, id, services);
        await recordAudit(tx, actor, {
          action: 'app.stop',
          target: { type: 'app', id },
          summary: { deploymentId: row?.id ?? null },
        });
        return row;
      });
      if (stopped) {
        deps.events.publish({
          topic: 'deployments',
          action: 'updated',
          resourceId: stopped.id,
          data: { appId: id, status: stopped.status },
        });
      }
      deps.events.publish({ topic: 'apps', action: 'updated', resourceId: id });
      return {
        appId: id,
        nodeId: app.nodeId,
        nodeOnline: true,
        source: 'agent',
        activeDeploymentId: null,
        services,
      };
    },

    async openLogs(id, query) {
      const app = await loadRow(deps.db, id);
      if (!deps.agents.isOnline(app.nodeId)) {
        throw new ProblemError('service-unavailable', {
          detail: 'The node of this app is offline',
        });
      }
      const request: LogsRequest = {
        app: target(app),
        tail: query.tail,
        follow: query.follow,
        ...(query.service === undefined ? {} : { service: query.service }),
      };
      const logger = deps.logger.child({ appId: id, nodeId: app.nodeId });

      return async function* stream(signal: AbortSignal): AsyncIterable<SseMessage> {
        const queue: AppLogLine[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        let reason: 'completed' | 'stopped' | 'error' = 'completed';
        const onAbort = () => wake?.();
        signal.addEventListener('abort', onAbort);
        const finished = deps.agents
          .streamLogs(
            app.nodeId,
            request,
            (line) => {
              queue.push(line);
              if (queue.length > MAX_BUFFERED_LINES) queue.shift();
              wake?.();
            },
            signal,
          )
          .then(
            () => {
              reason = signal.aborted ? 'stopped' : 'completed';
            },
            (error: unknown) => {
              reason = 'error';
              logger.warn(
                { reason: error instanceof Error ? error.message : 'unknown' },
                'app log stream failed',
              );
            },
          )
          .finally(() => {
            done = true;
            wake?.();
          });
        try {
          for (;;) {
            const line = queue.shift();
            if (line) {
              yield { event: SSE_EVENTS.log, data: line };
              continue;
            }
            if (done || signal.aborted) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
          if (!signal.aborted) yield { event: SSE_EVENTS.end, data: { reason } };
        } finally {
          signal.removeEventListener('abort', onAbort);
          await finished;
        }
      };
    },
  };
}
