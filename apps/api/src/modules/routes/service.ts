import {
  type CreateRouteInput,
  type DomainId,
  type Route,
  type RouteId,
  type RouteListQuery,
  type RoutePage,
  type RouteSaveResult,
  type RouteTarget,
  roleAtLeast,
  type UpdateRouteInput,
} from '@launchway/contracts';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import { effectiveRole, getActorPrincipal, type RequestActor } from '../../lib/auth-context.js';
import { afterCursor, createdAtKey, toPage } from '../../lib/pagination.js';
import { conflict, forbidden, invalidField, notFound } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { domains } from '../domains/schema.js';
import { type CaddyAdmin, createCaddyAdmin } from '../edge/caddy.js';
import { ALIASES_LOCK, assertAliasesFree } from './attach.js';
import { routes } from './schema.js';
import { targetColumns, toRouteTarget } from './target.js';
import { assertRedirectTarget, checkRouteDirectives, type DirectivesSite } from './validation.js';

type RouteRow = typeof routes.$inferSelect;

export interface RoutesService {
  list(query: RouteListQuery): Promise<RoutePage>;
  get(id: RouteId): Promise<Route>;
  create(input: CreateRouteInput, actor: RequestActor): Promise<RouteSaveResult>;
  update(id: RouteId, input: UpdateRouteInput, actor: RequestActor): Promise<RouteSaveResult>;
  remove(id: RouteId, actor: RequestActor): Promise<void>;
}

export interface RoutesServiceOptions {
  /** Validates extra directives (`/adapt`); defaults to the configured Caddy admin API. */
  readonly caddy?: Pick<CaddyAdmin, 'adapt'>;
}

/** Stored form of extra directives: line endings normalized, blank text means none. */
export function normalizeDirectives(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trimEnd();
  return normalized.trim() === '' ? null : normalized;
}

/** Extra directives are trusted edge configuration: only admins may change them. */
function assertMayChangeDirectives(actor: RequestActor): void {
  if (!roleAtLeast(effectiveRole(getActorPrincipal(actor)), 'admin')) {
    throw forbidden('Changing extra directives requires the admin role');
  }
}

const routeColumns = {
  route: routes,
  hostname: domains.hostname,
};

function toRoute(row: RouteRow, hostname: string): Route {
  return {
    id: row.id,
    domainId: row.domainId,
    hostname,
    target: toRouteTarget(row),
    protected: row.protected,
    compress: row.compress,
    hsts: row.hsts,
    extraDirectives: row.extraDirectives,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Audit view of a route: target flattened, no secrets involved. */
function auditView(row: RouteRow): Record<string, unknown> {
  return { ...row, target: toRouteTarget(row) };
}

/**
 * Business rules of a target beyond its schema (spec section 5): app targets need an existing app
 * and a network alias no other app uses; redirects must go to https.
 */
async function validateTarget(tx: Executor, target: RouteTarget, path: string): Promise<void> {
  assertRedirectTarget(target, path);
  if (target.kind !== 'app') return;

  const [app] = await tx
    .select({ id: apps.id, slug: apps.slug })
    .from(apps)
    .where(eq(apps.id, target.appId));
  if (!app) throw invalidField(`${path}.appId`, 'Unknown app');
  await assertAliasesFree(tx, app, [target.service], () => `${path}.service`);
}

export function createRoutesService(
  deps: Pick<Deps, 'db' | 'events' | 'config'>,
  options: RoutesServiceOptions = {},
): RoutesService {
  const caddy = options.caddy ?? createCaddyAdmin(deps.config.caddyAdminUrl);

  const checkDirectives = (site: DirectivesSite, directives: string | null) =>
    checkRouteDirectives(caddy, site, directives);

  async function load(db: Executor, id: RouteId, forUpdate = false) {
    const query = db
      .select(routeColumns)
      .from(routes)
      .innerJoin(domains, eq(routes.domainId, domains.id))
      .where(eq(routes.id, id));
    const [row] = forUpdate ? await query.for('update', { of: routes }) : await query;
    if (!row) throw notFound(`Route ${id} does not exist`);
    return row;
  }

  return {
    async list(query) {
      const conditions: (SQL | undefined)[] = [
        afterCursor(query.cursor, routes.createdAt, routes.id, 'asc'),
      ];
      if (query.appId) conditions.push(eq(routes.appId, query.appId));
      if (query.domainId) conditions.push(eq(routes.domainId, query.domainId));
      const rows = await deps.db
        .select({ ...routeColumns, id: routes.id, createdAtKey: createdAtKey(routes.createdAt) })
        .from(routes)
        .innerJoin(domains, eq(routes.domainId, domains.id))
        .where(and(...conditions))
        .orderBy(asc(routes.createdAt), asc(routes.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, (row) => toRoute(row.route, row.hostname));
    },

    async get(id) {
      const row = await load(deps.db, id);
      return toRoute(row.route, row.hostname);
    },

    async create(input, actor) {
      const extraDirectives = normalizeDirectives(input.extraDirectives);
      let warnings: string[] = [];
      if (extraDirectives !== null) {
        assertMayChangeDirectives(actor);
        const [domain] = await deps.db
          .select({ hostname: domains.hostname })
          .from(domains)
          .where(eq(domains.id, input.domainId));
        if (!domain) throw invalidField('body.domainId', 'Unknown domain');
        warnings = await checkDirectives({ ...input, hostname: domain.hostname }, extraDirectives);
      }
      let created: Route;
      try {
        created = await deps.db.transaction(async (tx) => {
          await tx.execute(ALIASES_LOCK);
          const [domain] = await tx
            .select({ id: domains.id, hostname: domains.hostname })
            .from(domains)
            .where(eq(domains.id, input.domainId));
          if (!domain) throw invalidField('body.domainId', 'Unknown domain');
          await assertDomainFree(tx, domain.id, domain.hostname);
          await validateTarget(tx, input.target, 'body.target');
          const [row] = await tx
            .insert(routes)
            .values({
              domainId: domain.id,
              ...targetColumns(input.target),
              protected: input.protected,
              compress: input.compress,
              hsts: input.hsts,
              extraDirectives,
            })
            .returning();
          if (!row) throw new Error('route insert returned no row');
          await recordAudit(tx, actor, {
            action: 'route.create',
            target: { type: 'route', id: row.id },
            summary: {
              hostname: domain.hostname,
              target: input.target,
              extraDirectives: extraDirectives !== null,
            },
          });
          return toRoute(row, domain.hostname);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('The domain already has a route');
        throw error;
      }
      deps.events.publish({ topic: 'routes', action: 'created', resourceId: created.id });
      return { ...created, warnings };
    },

    async update(id, input, actor) {
      const current = await load(deps.db, id);
      const directivesChanged =
        input.extraDirectives !== undefined &&
        normalizeDirectives(input.extraDirectives) !== current.route.extraDirectives;
      if (directivesChanged) assertMayChangeDirectives(actor);
      const nextDirectives = directivesChanged
        ? normalizeDirectives(input.extraDirectives)
        : current.route.extraDirectives;
      // Re-validate when the directives or the options around them change.
      const contextChanged =
        (input.protected !== undefined && input.protected !== current.route.protected) ||
        (input.compress !== undefined && input.compress !== current.route.compress) ||
        (input.hsts !== undefined && input.hsts !== current.route.hsts);
      const warnings =
        directivesChanged || (contextChanged && nextDirectives !== null)
          ? await checkDirectives(
              {
                hostname: current.hostname,
                protected: input.protected ?? current.route.protected,
                compress: input.compress ?? current.route.compress,
                hsts: input.hsts ?? current.route.hsts,
              },
              nextDirectives,
            )
          : [];

      const updated = await deps.db.transaction(async (tx) => {
        await tx.execute(ALIASES_LOCK);
        const before = await load(tx, id, true);
        if (directivesChanged && before.route.extraDirectives !== current.route.extraDirectives) {
          throw conflict('The extra directives changed concurrently; reload and try again');
        }
        if (input.target) await validateTarget(tx, input.target, 'body.target');
        const [after] = await tx
          .update(routes)
          .set({
            ...(input.target ? targetColumns(input.target) : {}),
            ...(input.protected === undefined ? {} : { protected: input.protected }),
            ...(input.compress === undefined ? {} : { compress: input.compress }),
            ...(input.hsts === undefined ? {} : { hsts: input.hsts }),
            ...(directivesChanged ? { extraDirectives: nextDirectives } : {}),
          })
          .where(eq(routes.id, id))
          .returning();
        if (!after) throw notFound(`Route ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'route.update',
          target: { type: 'route', id },
          summary: diffSummary(auditView(before.route), auditView(after), [
            'target',
            'protected',
            'compress',
            'hsts',
            'extraDirectives',
          ]),
        });
        return toRoute(after, before.hostname);
      });
      deps.events.publish({ topic: 'routes', action: 'updated', resourceId: id });
      return { ...updated, warnings };
    },

    async remove(id, actor) {
      await deps.db.transaction(async (tx) => {
        const row = await load(tx, id, true);
        await tx.delete(routes).where(eq(routes.id, id));
        await recordAudit(tx, actor, {
          action: 'route.delete',
          target: { type: 'route', id },
          summary: { hostname: row.hostname, target: toRouteTarget(row.route) },
        });
      });
      deps.events.publish({ topic: 'routes', action: 'deleted', resourceId: id });
    },
  };
}

async function assertDomainFree(tx: Executor, domainId: DomainId, hostname: string): Promise<void> {
  const [existing] = await tx
    .select({ id: routes.id })
    .from(routes)
    .where(eq(routes.domainId, domainId));
  if (existing) throw conflict(`${hostname} already has a route (${existing.id})`);
}
