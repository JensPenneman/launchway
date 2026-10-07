import { type AppId, serviceAlias } from '@launchway/contracts';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { conflict, invalidField } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { settings } from '../settings/schema.js';
import { routes } from './schema.js';
import { findAliasClash } from './validation.js';

/**
 * Serializes changes to the set of services on the proxy network (routes, `App.proxyServices`,
 * the forward-auth target) so the alias collision check cannot race.
 */
export const ALIASES_LOCK = sql`select pg_advisory_xact_lock(hashtext('launchway:routes'))`;

/** A service of an app that joins the proxy network under `<slug>-<service>`. */
export interface AttachedService {
  readonly appId: AppId;
  readonly slug: string;
  readonly service: string;
}

/**
 * Every service attached to the proxy network by configuration: route targets, `proxyServices`
 * and the forward-auth target service. With `appId`, only that app's services.
 */
export async function loadAttachedServices(
  db: Executor,
  filter: { appId?: AppId; excludeAppId?: AppId } = {},
): Promise<AttachedService[]> {
  const appCondition = filter.appId
    ? eq(apps.id, filter.appId)
    : filter.excludeAppId
      ? ne(apps.id, filter.excludeAppId)
      : undefined;
  const [routed, proxied, settingsRows] = await Promise.all([
    db
      .selectDistinct({ appId: apps.id, slug: apps.slug, service: routes.appService })
      .from(routes)
      .innerJoin(apps, eq(routes.appId, apps.id))
      .where(and(eq(routes.targetKind, 'app'), isNotNull(routes.appService), appCondition)),
    db
      .select({ appId: apps.id, slug: apps.slug, services: apps.proxyServices })
      .from(apps)
      .where(appCondition),
    db.select({ target: settings.forwardAuthTarget }).from(settings).where(eq(settings.id, 1)),
  ]);
  const result = new Map<string, AttachedService>();
  const add = (entry: AttachedService) => result.set(`${entry.appId}/${entry.service}`, entry);
  for (const row of routed) {
    if (row.service) add({ appId: row.appId, slug: row.slug, service: row.service });
  }
  for (const row of proxied) {
    for (const service of row.services) add({ appId: row.appId, slug: row.slug, service });
  }
  const target = settingsRows[0]?.target ?? null;
  if (target) {
    const owner = proxied.find((row) => row.appId === target.appId);
    if (owner) add({ appId: owner.appId, slug: owner.slug, service: target.service });
  }
  return [...result.values()];
}

/**
 * Throws 400 when an alias of `services` would exceed 63 characters and 409 when another app
 * already attaches a service under the same alias. Call inside a transaction holding
 * `ALIASES_LOCK`.
 */
export async function assertAliasesFree(
  tx: Executor,
  app: { readonly id: AppId; readonly slug: string },
  services: readonly string[],
  /** Field path of the service name at `index`, for the 400. */
  pathOf: (index: number) => string,
): Promise<void> {
  if (services.length === 0) return;
  const others = await loadAttachedServices(tx, { excludeAppId: app.id });
  for (const [index, service] of services.entries()) {
    let alias: string;
    try {
      alias = serviceAlias(app.slug, service);
    } catch {
      throw invalidField(
        pathOf(index),
        `The network alias "${app.slug}-${service}" would exceed 63 characters`,
      );
    }
    const clash = findAliasClash(alias, others);
    if (clash) {
      throw conflict(
        `The network alias "${alias}" is already used by service "${clash.service}" of app "${clash.slug}"`,
      );
    }
  }
}
