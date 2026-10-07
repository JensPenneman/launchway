import {
  type AppId,
  type CreatePreviewInput,
  type DomainId,
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  isInProgressStatus,
  OPEN_PREVIEW_STATUSES,
  PREVIEW_RETENTION_MS,
  type Preview,
  type PreviewId,
  type PreviewListQuery,
  type PreviewPage,
  type PreviewStatus,
  previewAgentAppId,
  previewEnvironmentName,
  previewSlug,
  previewSlugFits,
  renderPreviewHost,
} from '@launchway/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  type SQL,
} from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import { AgentUnavailableError } from '../../lib/agent-gateway.js';
import { type RequestActor, systemActor } from '../../lib/auth-context.js';
import { GitProviderError, type PullRequestInfo } from '../../lib/git-provider.js';
import { afterCursor, createdAtKey, toPage } from '../../lib/pagination.js';
import { conflict, invalidField, notFound, ProblemError } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { announceStatus } from '../deployments/model.js';
import { deployments } from '../deployments/schema.js';
import {
  createDeploymentsService,
  type DeploymentsService,
  markPreviewStopped,
} from '../deployments/service.js';
import { domains } from '../domains/schema.js';
import { createDomainsService, type DomainsService } from '../domains/service.js';
import { getConnection, providerFor, toGitProblem } from '../github/providers.js';
import { routes } from '../routes/schema.js';
import { createRoutesService, type RoutesService } from '../routes/service.js';
import { createSettingsService } from '../settings/service.js';
import { previews } from './schema.js';

type AppRow = typeof apps.$inferSelect;
type PreviewRow = typeof previews.$inferSelect;
type LastDeployment = Preview['lastDeployment'];

/** The head of a pull request as the webhook or the GitHub API reports it. */
export interface PullRequestHead {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly headSha: string;
}

export interface PreviewsServiceOptions {
  readonly domains?: DomainsService;
  readonly routes?: RoutesService;
  readonly deployments?: DeploymentsService;
}

export interface PreviewsService {
  /** Previews of one app, or of all apps without `appId` (newest first). */
  list(query: PreviewListQuery & { appId?: AppId }): Promise<PreviewPage>;
  get(id: PreviewId): Promise<Preview>;
  /** Opens (or updates) the preview of an open pull request at its current head (manual API). */
  create(appId: AppId, input: CreatePreviewInput, actor: RequestActor): Promise<Preview>;
  /** Deploys the preview's head commit again (re-creating its domain and route if needed). */
  redeploy(id: PreviewId, actor: RequestActor): Promise<Preview>;
  /** Removes the preview's containers, route and domain; the row stays for history. */
  close(id: PreviewId, actor: RequestActor): Promise<Preview>;
  /**
   * Webhook `opened` / `reopened` / `synchronize` / `labeled`: upserts the preview and deploys the
   * head. Returns null when the app has previews turned off or the preview deploys that head
   * already.
   */
  openFromPullRequest(
    app: AppRow,
    pr: PullRequestHead,
    actor: RequestActor,
  ): Promise<Preview | null>;
  /** Webhook `closed` (merged or not): closes the app's preview of that pull request, if any. */
  closeForPullRequest(app: AppRow, prNumber: number, actor: RequestActor): Promise<Preview | null>;
  /**
   * Before an app is deleted: removes what its previews created outside the database (DNS
   * records, Compose projects). Containers on an offline node are left behind.
   */
  removeAllForApp(appId: AppId, actor: RequestActor): Promise<void>;
  /** Derives the status of an open preview from its deployments (change feed, worker). */
  sync(id: PreviewId): Promise<void>;
  /** Worker pass: finish closing previews, re-sync open ones, purge old closed ones. */
  reconcile(now?: Date): Promise<void>;
}

/** Preview statuses in which a repeated event for the same head changes nothing. */
const DEPLOYING_PREVIEW_STATUSES: ReadonlySet<PreviewStatus> = new Set([
  'pending',
  'deploying',
  'running',
]);

function previewUrl(hostname: string): string {
  return `https://${hostname}`;
}

function toPreview(row: PreviewRow, last: LastDeployment): Preview {
  return {
    id: row.id,
    appId: row.appId,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    branch: row.branch,
    headSha: row.headSha,
    environmentName: previewEnvironmentName(row.prNumber),
    hostname: row.hostname,
    url: previewUrl(row.hostname),
    domainId: row.domainId,
    routeId: row.routeId,
    status: row.status,
    statusMessage: row.statusMessage,
    activeDeploymentId: row.activeDeploymentId,
    lastDeployment: last,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** Problems a webhook delivery should not be retried for (configuration, limits, bad input). */
function isPermanent(error: unknown): boolean {
  return error instanceof ProblemError && error.type !== 'upstream-failed';
}

function messageOf(error: unknown): string {
  if (error instanceof ProblemError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : 'unknown error';
}

export function createPreviewsService(
  deps: Deps,
  options: PreviewsServiceOptions = {},
): PreviewsService {
  const logger = deps.logger.child({ component: 'previews' });
  const settings = createSettingsService(deps);
  const domainsService = options.domains ?? createDomainsService(deps);
  const routesService = options.routes ?? createRoutesService(deps);
  const deploymentsService = options.deployments ?? createDeploymentsService(deps);

  async function loadRow(db: Executor, id: PreviewId, forUpdate = false): Promise<PreviewRow> {
    const query = db.select().from(previews).where(eq(previews.id, id));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Preview not found');
    return row;
  }

  async function loadApp(id: AppId): Promise<AppRow> {
    const [app] = await deps.db.select().from(apps).where(eq(apps.id, id));
    if (!app) throw notFound('App not found');
    return app;
  }

  /** Newest deployment per preview. */
  async function lastDeployments(
    ids: readonly PreviewId[],
  ): Promise<Map<PreviewId, LastDeployment>> {
    const result = new Map<PreviewId, LastDeployment>();
    if (ids.length === 0) return result;
    const rows = await deps.db
      .selectDistinctOn([deployments.previewId], {
        previewId: deployments.previewId,
        id: deployments.id,
        status: deployments.status,
        commitSha: deployments.commitSha,
      })
      .from(deployments)
      .where(inArray(deployments.previewId, [...ids]))
      .orderBy(deployments.previewId, desc(deployments.createdAt), desc(deployments.id));
    for (const row of rows) {
      if (row.previewId) {
        result.set(row.previewId, { id: row.id, status: row.status, commitSha: row.commitSha });
      }
    }
    return result;
  }

  async function present(row: PreviewRow): Promise<Preview> {
    return toPreview(row, (await lastDeployments([row.id])).get(row.id) ?? null);
  }

  function publish(
    row: Pick<PreviewRow, 'id' | 'appId' | 'status'>,
    action: 'created' | 'updated' | 'deleted',
  ) {
    deps.events.publish({
      topic: 'previews',
      action,
      resourceId: row.id,
      data: { appId: row.appId, status: row.status },
    });
  }

  /** The route previews copy: the app's first production route (not one of a preview). */
  async function productionRoute(appId: AppId) {
    const [route] = await deps.db
      .select({ route: routes })
      .from(routes)
      .leftJoin(previews, eq(previews.routeId, routes.id))
      .where(and(eq(routes.appId, appId), eq(routes.targetKind, 'app'), isNull(previews.id)))
      .orderBy(asc(routes.createdAt), asc(routes.id))
      .limit(1);
    return route?.route ?? null;
  }

  async function setFields(
    id: PreviewId,
    fields: Partial<Pick<PreviewRow, 'domainId' | 'routeId' | 'status' | 'statusMessage'>>,
  ): Promise<PreviewRow> {
    const [row] = await deps.db.update(previews).set(fields).where(eq(previews.id, id)).returning();
    if (!row) throw notFound('Preview not found');
    return row;
  }

  /** Marks a preview failed (setup error); audited, since no deployment records the reason. */
  async function markFailed(id: PreviewId, message: string, actor: RequestActor): Promise<void> {
    const failed = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(previews)
        .set({ status: 'failed', statusMessage: message.slice(0, 2000) })
        .where(
          and(eq(previews.id, id), inArray(previews.status, ['pending', 'deploying', 'failed'])),
        )
        .returning();
      if (row) {
        await recordAudit(tx, actor, {
          action: 'preview.fail',
          target: { type: 'preview', id },
          summary: { appId: row.appId, prNumber: row.prNumber, reason: message.slice(0, 200) },
        });
      }
      return row;
    });
    if (failed) publish(failed, 'updated');
  }

  /**
   * Creates the preview's domain (CNAME to the anchor through the managed zone, DNS check forced)
   * and its route (the production route's service and options, without extra directives).
   * Idempotent: what exists is kept; a domain of the same name without a route is adopted.
   */
  async function ensureEdge(row: PreviewRow, actor: RequestActor): Promise<PreviewRow> {
    let current = row;
    if (current.routeId && current.domainId) return current;
    const production = await productionRoute(current.appId);
    if (!production?.appService || !production.appPort) {
      throw conflict(
        'The app has no route: a preview serves the service and port of its first route',
      );
    }
    let domainId: DomainId | null = current.domainId;
    if (!domainId) {
      const [existing] = await deps.db
        .select({ id: domains.id, routeId: routes.id })
        .from(domains)
        .leftJoin(routes, eq(routes.domainId, domains.id))
        .where(eq(domains.hostname, current.hostname));
      if (existing?.routeId) {
        throw conflict(
          `${current.hostname} already serves another route; change the host template`,
        );
      }
      domainId =
        existing?.id ??
        (
          await domainsService.create(
            { hostname: current.hostname, proxied: false, force: true },
            actor,
          )
        ).id;
      current = await setFields(current.id, { domainId });
    }
    if (!current.routeId) {
      const route = await routesService.create(
        {
          domainId,
          target: {
            kind: 'app',
            appId: current.appId,
            service: production.appService,
            port: production.appPort,
          },
          protected: production.protected,
          compress: production.compress,
          hsts: production.hsts,
        },
        actor,
      );
      current = await setFields(current.id, { routeId: route.id });
    }
    return current;
  }

  /** Upserts the preview row of a pull request (limits apply when it is not open yet). */
  async function upsert(
    app: AppRow,
    pr: PullRequestHead,
    actor: RequestActor,
  ): Promise<{ row: PreviewRow; created: boolean }> {
    const platform = await settings.get();
    const base = platform.previewBaseDomain;
    if (!base) {
      throw conflict('Set the preview base domain in the platform settings to use previews');
    }
    if (!previewSlugFits(app.slug, pr.number)) {
      throw conflict(
        `The app slug ${app.slug} is too long for previews: ${previewSlug(app.slug, pr.number)} exceeds 40 characters`,
      );
    }
    let created = false;
    let row: PreviewRow;
    try {
      row = await deps.db.transaction(async (tx) => {
        // Serializes with other previews of the app (limits) and with dispatching.
        await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, app.id)).for('update');
        const [existing] = await tx
          .select()
          .from(previews)
          .where(and(eq(previews.appId, app.id), eq(previews.prNumber, pr.number)))
          .for('update');
        if (existing?.status === 'closing') {
          throw conflict('The preview of this pull request is being removed; try again shortly');
        }
        const reopening = !existing || existing.status === 'closed';
        if (reopening) {
          const open = inArray(previews.status, [...OPEN_PREVIEW_STATUSES]);
          const [[perApp], [total]] = await Promise.all([
            tx
              .select({ n: count() })
              .from(previews)
              .where(and(eq(previews.appId, app.id), open)),
            tx.select({ n: count() }).from(previews).where(open),
          ]);
          if ((perApp?.n ?? 0) >= platform.previewMaxPerApp) {
            throw conflict(
              `App ${app.slug} has ${perApp?.n ?? 0} open previews, the limit is ${platform.previewMaxPerApp}`,
            );
          }
          if ((total?.n ?? 0) >= platform.previewMaxTotal) {
            throw conflict(
              `${total?.n ?? 0} previews are open, the platform limit is ${platform.previewMaxTotal}`,
            );
          }
        }
        let hostname = existing && !reopening ? existing.hostname : null;
        if (hostname === null) {
          try {
            hostname = renderPreviewHost(app.previews.hostTemplate, {
              slug: app.slug,
              number: pr.number,
              base,
            });
          } catch (error) {
            throw conflict(
              `The preview host template gives no valid host name: ${messageOf(error)}`,
            );
          }
        }
        const fields = {
          prTitle: pr.title.slice(0, 500),
          headSha: pr.headSha,
          branch: pr.branch.slice(0, 255),
          hostname,
        };
        let saved: PreviewRow | undefined;
        if (existing) {
          [saved] = await tx
            .update(previews)
            .set({
              ...fields,
              ...(reopening
                ? { status: 'pending' as const, statusMessage: null, closedAt: null }
                : {}),
            })
            .where(eq(previews.id, existing.id))
            .returning();
        } else {
          [saved] = await tx
            .insert(previews)
            .values({ appId: app.id, prNumber: pr.number, ...fields })
            .returning();
          created = true;
        }
        if (!saved) throw new Error('preview upsert returned no row');
        await recordAudit(tx, actor, {
          action: created ? 'preview.create' : reopening ? 'preview.reopen' : 'preview.update',
          target: { type: 'preview', id: saved.id },
          summary: {
            appId: app.id,
            prNumber: pr.number,
            hostname,
            headSha:
              existing && existing.headSha !== pr.headSha
                ? { from: existing.headSha, to: pr.headSha }
                : pr.headSha,
          },
        });
        return saved;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('The preview changed meanwhile; try again');
      throw error;
    }
    publish(row, created ? 'created' : 'updated');
    return { row, created };
  }

  /** Domain + route, then a deployment of the head; setup failures mark the preview failed. */
  async function deploy(
    app: AppRow,
    initial: PreviewRow,
    actor: RequestActor,
    dispatch: 'await' | 'background',
  ): Promise<PreviewRow> {
    let row = initial;
    try {
      row = await ensureEdge(row, actor);
      await deploymentsService.createForPreview(
        app,
        { id: row.id, prNumber: row.prNumber, headSha: row.headSha },
        actor,
        dispatch,
      );
    } catch (error) {
      logger.warn(
        { previewId: row.id, appId: app.id, reason: messageOf(error) },
        'preview setup failed',
      );
      await markFailed(row.id, messageOf(error), actor);
      throw error;
    }
    await sync(row.id);
    return loadRow(deps.db, row.id);
  }

  async function open(
    app: AppRow,
    pr: PullRequestHead,
    actor: RequestActor,
    dispatch: 'await' | 'background',
  ): Promise<Preview> {
    if (!app.previews.enabled) throw conflict('Previews are turned off for this app');
    const { row } = await upsert(app, pr, actor);
    return present(await deploy(app, row, actor, dispatch));
  }

  /** Derives status and active deployment from the preview's deployments. */
  async function sync(id: PreviewId): Promise<void> {
    const changed = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(previews).where(eq(previews.id, id)).for('update');
      if (!row || row.status === 'closing' || row.status === 'closed') return null;
      const [latest] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.previewId, id))
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(1);
      const [running] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.previewId, id), eq(deployments.status, 'running')));
      let status: PreviewStatus = row.status;
      let statusMessage = row.statusMessage;
      if (!latest) {
        // Nothing deployed yet: keep a setup failure, otherwise wait.
        status = row.status === 'failed' ? 'failed' : 'pending';
      } else if (isInProgressStatus(latest.status)) {
        status = 'deploying';
        statusMessage = null;
      } else if (running) {
        status = 'running';
        statusMessage =
          latest.status === 'failed' || latest.status === 'cancelled'
            ? `The newest deployment ${latest.status === 'failed' ? 'failed' : 'was cancelled'}; an older one keeps running`
            : null;
      } else {
        status = 'failed';
        statusMessage = latest.statusMessage ?? `The deployment is ${latest.status}`;
      }
      const activeDeploymentId = running?.id ?? null;
      if (
        status === row.status &&
        statusMessage === row.statusMessage &&
        activeDeploymentId === row.activeDeploymentId
      ) {
        return null;
      }
      const [updated] = await tx
        .update(previews)
        .set({ status, statusMessage: statusMessage?.slice(0, 2000) ?? null, activeDeploymentId })
        .where(eq(previews.id, id))
        .returning();
      return updated ?? null;
    });
    if (changed) publish(changed, 'updated');
  }

  /** Removes the preview's Compose project from every node that ran it; false if one is offline. */
  async function removeProjects(
    row: PreviewRow,
    app: Pick<AppRow, 'slug' | 'nodeId'>,
  ): Promise<boolean> {
    const used = await deps.db
      .selectDistinct({ nodeId: deployments.nodeId })
      .from(deployments)
      .where(and(eq(deployments.previewId, row.id), ne(deployments.status, 'cancelled')));
    const target = { id: previewAgentAppId(row.id), slug: previewSlug(app.slug, row.prNumber) };
    let complete = true;
    for (const { nodeId } of used) {
      if (!deps.agents.isOnline(nodeId)) {
        complete = false;
        continue;
      }
      try {
        // Preview data is disposable: its named volumes go too.
        await deps.agents.removeApp(nodeId, target, true);
      } catch (error) {
        if (!(error instanceof AgentUnavailableError)) {
          logger.warn(
            { previewId: row.id, nodeId, reason: messageOf(error) },
            'removing a preview failed',
          );
        }
        complete = false;
      }
    }
    return complete;
  }

  /** Cancels what is still in progress for the preview (best effort). */
  async function cancelDeployments(row: PreviewRow, actor: RequestActor): Promise<void> {
    const pending = await deps.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.previewId, row.id),
          inArray(deployments.status, IN_PROGRESS_DEPLOYMENT_STATUSES),
        ),
      );
    for (const { id } of pending) {
      try {
        await deploymentsService.cancel(id, actor);
      } catch (error) {
        logger.warn(
          { previewId: row.id, deploymentId: id, reason: messageOf(error) },
          'could not cancel a preview deployment',
        );
      }
    }
  }

  /**
   * Closing: route and domain (with its DNS record) go first, so nothing serves the preview any
   * more; then the Compose project. A step that cannot finish (node offline, DNS provider down)
   * leaves the preview `closing`; the worker retries.
   */
  async function finishClose(initial: PreviewRow, actor: RequestActor): Promise<PreviewRow> {
    let row = initial;
    const app = await loadApp(row.appId);
    await cancelDeployments(row, actor);
    const problems: string[] = [];
    if (row.routeId) {
      try {
        await routesService.remove(row.routeId, actor);
      } catch (error) {
        if (!(error instanceof ProblemError && error.type === 'not-found')) {
          problems.push(`route: ${messageOf(error)}`);
        }
      }
      if (problems.length === 0) row = await setFields(row.id, { routeId: null });
    }
    if (row.domainId && problems.length === 0) {
      try {
        await domainsService.remove(row.domainId, actor);
      } catch (error) {
        if (!(error instanceof ProblemError && error.type === 'not-found')) {
          problems.push(`domain: ${messageOf(error)}`);
        }
      }
      if (problems.length === 0) row = await setFields(row.id, { domainId: null });
    }
    if (!(await removeProjects(row, app))) {
      problems.push('the node is offline; its containers are removed once it is back');
    }
    if (problems.length > 0) {
      const message = `Removal incomplete: ${problems.join('; ')}`;
      if (message !== row.statusMessage) {
        row = await setFields(row.id, { statusMessage: message });
        publish(row, 'updated');
      }
      return row;
    }
    const { closed, stopped } = await deps.db.transaction(async (tx) => {
      const stoppedRow = await markPreviewStopped(tx, row.id);
      const [updated] = await tx
        .update(previews)
        .set({
          status: 'closed',
          statusMessage: null,
          activeDeploymentId: null,
          closedAt: new Date(),
        })
        .where(and(eq(previews.id, row.id), eq(previews.status, 'closing')))
        .returning();
      if (updated) {
        await recordAudit(tx, actor, {
          action: 'preview.remove',
          target: { type: 'preview', id: row.id },
          summary: { appId: row.appId, prNumber: row.prNumber, hostname: row.hostname },
        });
      }
      return { closed: updated, stopped: stoppedRow };
    });
    if (stopped) announceStatus(deps, stopped, false);
    if (!closed) return loadRow(deps.db, row.id);
    publish(closed, 'updated');
    logger.info({ previewId: row.id, appId: row.appId }, 'preview closed');
    return closed;
  }

  async function beginClose(
    id: PreviewId,
    actor: RequestActor,
    reason: string,
  ): Promise<PreviewRow> {
    const row = await deps.db.transaction(async (tx) => {
      const current = await loadRow(tx, id, true);
      if (current.status === 'closed' || current.status === 'closing') return current;
      const [updated] = await tx
        .update(previews)
        .set({ status: 'closing', statusMessage: null })
        .where(eq(previews.id, id))
        .returning();
      if (!updated) throw notFound('Preview not found');
      await recordAudit(tx, actor, {
        action: 'preview.close',
        target: { type: 'preview', id },
        summary: { appId: current.appId, prNumber: current.prNumber, reason },
      });
      return updated;
    });
    if (row.status === 'closing') publish(row, 'updated');
    return row;
  }

  async function close(id: PreviewId, actor: RequestActor, reason: string): Promise<PreviewRow> {
    const row = await beginClose(id, actor, reason);
    if (row.status === 'closed') return row;
    return finishClose(row, actor);
  }

  return {
    async list(query) {
      if (query.appId) await loadApp(query.appId);
      const conditions: (SQL | undefined)[] = [
        afterCursor(query.cursor, previews.createdAt, previews.id, 'desc'),
      ];
      if (query.appId) conditions.push(eq(previews.appId, query.appId));
      if (query.status) conditions.push(eq(previews.status, query.status));
      if (query.open === true) conditions.push(ne(previews.status, 'closed'));
      if (query.open === false) conditions.push(eq(previews.status, 'closed'));
      const rows = await deps.db
        .select({ row: previews, id: previews.id, createdAtKey: createdAtKey(previews.createdAt) })
        .from(previews)
        .where(and(...conditions))
        .orderBy(desc(previews.createdAt), desc(previews.id))
        .limit(query.limit + 1);
      const last = await lastDeployments(rows.slice(0, query.limit).map((r) => r.id));
      return toPage(rows, query.limit, (r) => toPreview(r.row, last.get(r.id) ?? null));
    },

    async get(id) {
      return present(await loadRow(deps.db, id));
    },

    async create(appId, input, actor) {
      const app = await loadApp(appId);
      if (!app.previews.enabled) throw conflict('Previews are turned off for this app');
      const connection = await getConnection(deps.db, app.connectionId);
      let pr: PullRequestInfo;
      try {
        pr = await providerFor(deps, connection).getPullRequest(
          app.repoOwner,
          app.repoName,
          input.prNumber,
        );
      } catch (error) {
        if (error instanceof GitProviderError && error.kind === 'not-found') {
          throw invalidField(
            'body.prNumber',
            `Pull request #${input.prNumber} not found in ${app.repoOwner}/${app.repoName}`,
          );
        }
        throw toGitProblem(error);
      }
      if (pr.state !== 'open') throw conflict(`Pull request #${pr.number} is not open`);
      if (pr.headRepoFullName?.toLowerCase() !== pr.baseRepoFullName.toLowerCase()) {
        throw conflict('Pull requests from forks get no preview: their code is not trusted');
      }
      return open(
        app,
        { number: pr.number, title: pr.title, branch: pr.headRef, headSha: pr.headSha },
        actor,
        'await',
      );
    },

    async redeploy(id, actor) {
      const row = await loadRow(deps.db, id);
      if (row.status === 'closing' || row.status === 'closed') {
        throw conflict('The preview is closed; open it again from its pull request');
      }
      const app = await loadApp(row.appId);
      return present(await deploy(app, row, actor, 'await'));
    },

    async close(id, actor) {
      return present(await close(id, actor, 'manual'));
    },

    async openFromPullRequest(app, pr, actor) {
      if (!app.previews.enabled) {
        logger.info({ appId: app.id, prNumber: pr.number }, 'previews are off for the app');
        return null;
      }
      // GitHub sends `labeled` right after `opened` for a pull request opened with labels; a
      // second deployment of the same commit would only cancel the first.
      const [current] = await deps.db
        .select({ status: previews.status, headSha: previews.headSha })
        .from(previews)
        .where(and(eq(previews.appId, app.id), eq(previews.prNumber, pr.number)));
      if (current?.headSha === pr.headSha && DEPLOYING_PREVIEW_STATUSES.has(current.status)) {
        logger.info(
          { appId: app.id, prNumber: pr.number },
          'the preview deploys this head already',
        );
        return null;
      }
      try {
        return await open(app, pr, actor, 'background');
      } catch (error) {
        if (!isPermanent(error)) throw error;
        logger.warn(
          { appId: app.id, prNumber: pr.number, reason: messageOf(error) },
          'pull request got no preview',
        );
        return null;
      }
    },

    async closeForPullRequest(app, prNumber, actor) {
      const [row] = await deps.db
        .select()
        .from(previews)
        .where(and(eq(previews.appId, app.id), eq(previews.prNumber, prNumber)));
      if (!row || row.status === 'closed') return null;
      return present(await close(row.id, actor, 'pull request closed'));
    },

    async removeAllForApp(appId, actor) {
      const rows = await deps.db
        .select()
        .from(previews)
        .where(and(eq(previews.appId, appId), ne(previews.status, 'closed')));
      for (const row of rows) {
        try {
          await close(row.id, actor, 'app deleted');
        } catch (error) {
          logger.warn(
            { previewId: row.id, reason: messageOf(error) },
            'could not remove a preview of a deleted app',
          );
        }
      }
    },

    sync,

    async reconcile(now = new Date()) {
      const actor = systemActor('previews');
      const closing = await deps.db.select().from(previews).where(eq(previews.status, 'closing'));
      for (const row of closing) {
        try {
          await finishClose(row, actor);
        } catch (error) {
          logger.warn(
            { previewId: row.id, reason: messageOf(error) },
            'finishing a preview removal failed',
          );
        }
      }
      const open = await deps.db
        .select({ id: previews.id })
        .from(previews)
        .where(notInArray(previews.status, ['closing', 'closed']));
      for (const { id } of open) await sync(id);

      const cutoff = new Date(now.getTime() - PREVIEW_RETENTION_MS);
      const purged = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .delete(previews)
          .where(and(eq(previews.status, 'closed'), lt(previews.closedAt, cutoff)))
          .returning();
        for (const row of rows) {
          await recordAudit(tx, actor, {
            action: 'preview.purge',
            target: { type: 'preview', id: row.id },
            summary: { appId: row.appId, prNumber: row.prNumber },
          });
        }
        return rows;
      });
      for (const row of purged) publish(row, 'deleted');
      if (purged.length > 0) logger.info({ count: purged.length }, 'purged closed previews');
    },
  };
}
