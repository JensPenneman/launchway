import type {
  CreateRouteInput,
  DomainId,
  Route,
  RouteId,
  RouteListQuery,
  RoutePage,
  RouteTarget,
  UpdateRouteInput,
} from '@slipway/contracts';
import { and, asc, eq, ne, type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { afterCursor, createdAtKey, toPage } from '../../lib/pagination.js';
import { conflict, invalidField, notFound } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { domains } from '../domains/schema.js';
import { routes } from './schema.js';
import { targetColumns, toRouteTarget } from './target.js';
import { assertRedirectTarget, findAliasClash, routeAlias } from './validation.js';

type RouteRow = typeof routes.$inferSelect;

/** Serializes route mutations so the alias collision check cannot race. */
const ROUTES_LOCK = sql`select pg_advisory_xact_lock(hashtext('slipway:routes'))`;

export interface RoutesService {
  list(query: RouteListQuery): Promise<RoutePage>;
  get(id: RouteId): Promise<Route>;
  create(input: CreateRouteInput, actor: RequestActor): Promise<Route>;
  update(id: RouteId, input: UpdateRouteInput, actor: RequestActor): Promise<Route>;
  remove(id: RouteId, actor: RequestActor): Promise<void>;
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

  const alias = routeAlias(app.slug, target.service, path);
  const others = await tx
    .selectDistinct({ slug: apps.slug, service: routes.appService })
    .from(routes)
    .innerJoin(apps, eq(routes.appId, apps.id))
    .where(and(eq(routes.targetKind, 'app'), ne(apps.id, app.id)));
  const clash = findAliasClash(alias, others);
  if (clash) {
    throw conflict(
      `The network alias "${alias}" is already used by service "${clash.service}" of app "${clash.slug}"`,
    );
  }
}

export function createRoutesService(deps: Pick<Deps, 'db' | 'events'>): RoutesService {
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
      let created: Route;
      try {
        created = await deps.db.transaction(async (tx) => {
          await tx.execute(ROUTES_LOCK);
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
            })
            .returning();
          if (!row) throw new Error('route insert returned no row');
          await recordAudit(tx, actor, {
            action: 'route.create',
            target: { type: 'route', id: row.id },
            summary: { hostname: domain.hostname, target: input.target },
          });
          return toRoute(row, domain.hostname);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('The domain already has a route');
        throw error;
      }
      deps.events.publish({ topic: 'routes', action: 'created', resourceId: created.id });
      return created;
    },

    async update(id, input, actor) {
      const updated = await deps.db.transaction(async (tx) => {
        await tx.execute(ROUTES_LOCK);
        const before = await load(tx, id, true);
        if (input.target) await validateTarget(tx, input.target, 'body.target');
        const [after] = await tx
          .update(routes)
          .set({
            ...(input.target ? targetColumns(input.target) : {}),
            ...(input.protected === undefined ? {} : { protected: input.protected }),
            ...(input.compress === undefined ? {} : { compress: input.compress }),
            ...(input.hsts === undefined ? {} : { hsts: input.hsts }),
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
          ]),
        });
        return toRoute(after, before.hostname);
      });
      deps.events.publish({ topic: 'routes', action: 'updated', resourceId: id });
      return updated;
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
