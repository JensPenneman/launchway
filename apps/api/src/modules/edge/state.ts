import { and, eq, inArray } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { apps } from '../apps/schema.js';
import { deployments } from '../deployments/schema.js';
import { domains } from '../domains/schema.js';
import { nodes } from '../nodes/schema.js';
import { routes } from '../routes/schema.js';
import { toRouteTarget } from '../routes/target.js';
import { settings } from '../settings/schema.js';
import type { EdgeApp, EdgeRenderInput } from './render.js';

/** Reads everything the renderer needs (read-only joins across modules). */
export async function loadEdgeInput(deps: Pick<Deps, 'db' | 'config'>): Promise<EdgeRenderInput> {
  const { db, config } = deps;
  const [settingsRows, routeRows, nodeRows] = await Promise.all([
    db.select().from(settings).where(eq(settings.id, 1)),
    db
      .select({
        route: routes,
        hostname: domains.hostname,
        status: domains.status,
        force: domains.force,
      })
      .from(routes)
      .innerJoin(domains, eq(routes.domainId, domains.id)),
    db.select({ id: nodes.id, name: nodes.name, lanIp: nodes.lanIp }).from(nodes),
  ]);
  const settingsRow = settingsRows[0];

  const appIds = [
    ...new Set(routeRows.flatMap((row) => (row.route.appId ? [row.route.appId] : []))),
  ];
  let edgeApps: EdgeApp[] = [];
  if (appIds.length > 0) {
    const [appRows, running] = await Promise.all([
      db
        .select({ id: apps.id, slug: apps.slug, nodeId: apps.nodeId })
        .from(apps)
        .where(inArray(apps.id, appIds)),
      db
        .select({ appId: deployments.appId, services: deployments.services })
        .from(deployments)
        .where(and(inArray(deployments.appId, appIds), eq(deployments.status, 'running'))),
    ]);
    const servicesByApp = new Map(running.map((row) => [row.appId, row.services]));
    edgeApps = appRows.map((app) => ({
      ...app,
      runningServices: servicesByApp.get(app.id) ?? null,
    }));
  }

  return {
    adminListen: config.caddyAdminListen,
    settings: {
      publicUrl: config.publicUrl ?? settingsRow?.publicUrl ?? null,
      acmeEmail: settingsRow?.acmeEmail ?? config.acmeEmail,
      forwardAuthUrl: settingsRow?.forwardAuthUrl ?? null,
      edgeNodeId: settingsRow?.edgeNodeId ?? null,
    },
    routes: routeRows.map((row) => ({
      id: row.route.id,
      domainId: row.route.domainId,
      hostname: row.hostname,
      domain: { status: row.status, force: row.force },
      target: toRouteTarget(row.route),
      protected: row.route.protected,
      compress: row.route.compress,
      hsts: row.route.hsts,
    })),
    apps: edgeApps,
    nodes: nodeRows,
  };
}
