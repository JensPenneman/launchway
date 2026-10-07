import { PRODUCTION_ENVIRONMENT } from '@launchway/contracts';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { apps } from '../apps/schema.js';
import { deployments } from '../deployments/schema.js';
import { domains } from '../domains/schema.js';
import { nodes } from '../nodes/schema.js';
import { previews } from '../previews/schema.js';
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
        preview: { id: previews.id, number: previews.prNumber },
      })
      .from(routes)
      .innerJoin(domains, eq(routes.domainId, domains.id))
      .leftJoin(previews, eq(previews.routeId, routes.id)),
    db.select({ id: nodes.id, name: nodes.name, lanIp: nodes.lanIp }).from(nodes),
  ]);
  const settingsRow = settingsRows[0];

  const forwardAuthTarget = settingsRow?.forwardAuthTarget ?? null;
  const appIds = [
    ...new Set([
      ...routeRows.flatMap((row) => (row.route.appId ? [row.route.appId] : [])),
      ...(forwardAuthTarget ? [forwardAuthTarget.appId] : []),
    ]),
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
        .where(
          and(
            inArray(deployments.appId, appIds),
            eq(deployments.environmentName, PRODUCTION_ENVIRONMENT),
            eq(deployments.status, 'running'),
          ),
        ),
    ]);
    const servicesByApp = new Map(running.map((row) => [row.appId, row.services]));
    edgeApps = appRows.map((app) => ({
      ...app,
      runningServices: servicesByApp.get(app.id) ?? null,
    }));
  }

  // Running deployments of the previews that have a route (their published ports, off the edge).
  const previewIds = routeRows.flatMap((row) => (row.preview ? [row.preview.id] : []));
  const previewServices = new Map(
    previewIds.length === 0
      ? []
      : (
          await db
            .select({ previewId: deployments.previewId, services: deployments.services })
            .from(deployments)
            .where(
              and(
                inArray(deployments.previewId, previewIds),
                isNotNull(deployments.previewId),
                eq(deployments.status, 'running'),
              ),
            )
        ).map((row) => [row.previewId, row.services]),
  );

  return {
    adminListen: config.caddyAdminListen,
    settings: {
      publicUrl: config.publicUrl ?? settingsRow?.publicUrl ?? null,
      acmeEmail: settingsRow?.acmeEmail ?? config.acmeEmail,
      forwardAuthUrl: settingsRow?.forwardAuthUrl ?? null,
      forwardAuthTarget,
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
      extraDirectives: row.route.extraDirectives,
      preview: row.preview
        ? {
            number: row.preview.number,
            runningServices: previewServices.get(row.preview.id) ?? null,
          }
        : null,
    })),
    apps: edgeApps,
    nodes: nodeRows,
  };
}
