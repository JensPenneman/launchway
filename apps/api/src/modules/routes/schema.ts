import { type AppId, type DomainId, ROUTE_TARGET_KINDS } from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idColumn, timestamps } from '../../db/columns.js';
import { apps } from '../apps/schema.js';
import { domains } from '../domains/schema.js';

export const routeTargetKind = pgEnum('route_target_kind', ROUTE_TARGET_KINDS);

/**
 * What a domain serves (one route per domain). The target union of the API is stored in
 * kind-prefixed columns; a CHECK constraint keeps each kind's columns complete.
 */
export const routes = pgTable(
  'routes',
  {
    id: idColumn('rt'),
    domainId: text('domain_id')
      .$type<DomainId>()
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    targetKind: routeTargetKind('target_kind').notNull(),
    // kind = app
    appId: text('app_id')
      .$type<AppId>()
      .references(() => apps.id, { onDelete: 'cascade' }),
    appService: text('app_service'),
    appPort: integer('app_port'),
    // kind = external
    externalScheme: text('external_scheme').$type<'http' | 'https'>(),
    externalHost: text('external_host'),
    externalPort: integer('external_port'),
    // kind = redirect
    redirectTo: text('redirect_to'),
    redirectPermanent: boolean('redirect_permanent'),
    // options
    protected: boolean('protected').notNull().default(false),
    compress: boolean('compress').notNull().default(true),
    hsts: boolean('hsts').notNull().default(true),
    /** Admin-supplied Caddyfile directives rendered verbatim inside the site block. */
    extraDirectives: text('extra_directives'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('routes_domain_id_key').on(t.domainId),
    index('routes_app_id_idx').on(t.appId),
    check(
      'routes_target_complete',
      sql`(${t.targetKind} = 'app' AND ${t.appId} IS NOT NULL AND ${t.appService} IS NOT NULL AND ${t.appPort} IS NOT NULL) OR (${t.targetKind} = 'external' AND ${t.externalScheme} IS NOT NULL AND ${t.externalHost} IS NOT NULL AND ${t.externalPort} IS NOT NULL) OR (${t.targetKind} = 'redirect' AND ${t.redirectTo} IS NOT NULL AND ${t.redirectPermanent} IS NOT NULL)`,
    ),
  ],
);
