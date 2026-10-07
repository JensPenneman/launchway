import {
  type AppId,
  type DeploymentId,
  type DomainId,
  PREVIEW_STATUSES,
  type RouteId,
} from '@launchway/contracts';
import { index, integer, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { apps } from '../apps/schema.js';
import { domains } from '../domains/schema.js';
import { routes } from '../routes/schema.js';

export const previewStatus = pgEnum('preview_status', PREVIEW_STATUSES);

/**
 * Preview environments of pull requests: one row per app and pull request number. A closed row is
 * reopened when the pull request is; closed rows are purged (with their deployments) after
 * PREVIEW_RETENTION_MS.
 */
export const previews = pgTable(
  'previews',
  {
    id: idColumn('prv'),
    appId: text('app_id')
      .$type<AppId>()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    prTitle: text('pr_title').notNull(),
    headSha: text('head_sha').notNull(),
    branch: text('branch').notNull(),
    /** Lower-case FQDN rendered from the app's host template when the preview opened. */
    hostname: text('hostname').notNull(),
    /** The domain the preview created (null once removed or before it exists). */
    domainId: text('domain_id')
      .$type<DomainId>()
      .references(() => domains.id, { onDelete: 'set null' }),
    /** The route the preview created; the edge renders it with the preview's aliases. */
    routeId: text('route_id')
      .$type<RouteId>()
      .references(() => routes.id, { onDelete: 'set null' }),
    status: previewStatus('status').notNull().default('pending'),
    statusMessage: text('status_message'),
    /**
     * The running deployment of the preview. No foreign key: deployments reference previews, and a
     * deployment only disappears together with its preview or app.
     */
    activeDeploymentId: text('active_deployment_id').$type<DeploymentId>(),
    closedAt: tz('closed_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('previews_app_id_pr_number_key').on(t.appId, t.prNumber),
    uniqueIndex('previews_route_id_key').on(t.routeId),
    index('previews_status_idx').on(t.status),
  ],
);
