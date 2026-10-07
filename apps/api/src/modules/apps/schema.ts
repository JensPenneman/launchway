import type { AppId, AppPreviewSettings, GitHubConnectionId, NodeId } from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps } from '../../db/columns.js';
import { githubConnections } from '../github/schema.js';
import { nodes } from '../nodes/schema.js';

/**
 * Deployable units. `App.activeDeploymentId` (API) is derived from `deployments`: the one
 * production row with status `running` (enforced by deployments_one_running_per_environment), so
 * it cannot go stale.
 */
export const apps = pgTable(
  'apps',
  {
    id: idColumn('app'),
    /** URL-safe, immutable; used in Compose project names and network aliases. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    connectionId: text('connection_id')
      .$type<GitHubConnectionId>()
      .notNull()
      .references(() => githubConnections.id, { onDelete: 'restrict' }),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    /** Set for Compose apps (XOR dockerfile). */
    composeFiles: text('compose_files').array(),
    dockerfile: text('dockerfile'),
    context: text('context'),
    nodeId: text('node_id')
      .$type<NodeId>()
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    autoDeployReleases: boolean('auto_deploy_releases').notNull().default(false),
    /** With autoDeployReleases: prereleases deploy too. */
    autoDeployPrereleases: boolean('auto_deploy_prereleases').notNull().default(false),
    /** Pushes to this branch create an automatic deployment of the pushed commit. */
    autoDeployBranch: text('auto_deploy_branch'),
    /** Mirror deployments to GitHub's Deployments API (ADR 0017). */
    githubDeployments: boolean('github_deployments').notNull().default(true),
    /** Admin decision: bind mounts below the node's allowed roots and foreign volumes. */
    trustedMounts: boolean('trusted_mounts').notNull().default(false),
    /** Services attached to the proxy network without a route (sorted, unique). */
    proxyServices: text('proxy_services').array().notNull().default(sql`'{}'::text[]`),
    /** `AppPreviewSettings` (enabled, host template, env overrides, compose files). */
    previews: jsonb('previews')
      .$type<AppPreviewSettings>()
      .notNull()
      .default(
        sql`'{"enabled":false,"hostTemplate":"{slug}-pr-{number}.{base}","envOverrides":{},"composeFiles":null}'::jsonb`,
      ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('apps_slug_key').on(t.slug),
    index('apps_node_id_idx').on(t.nodeId),
    index('apps_connection_id_idx').on(t.connectionId),
    check('apps_source_xor', sql`(${t.composeFiles} IS NULL) <> (${t.dockerfile} IS NULL)`),
    check(
      'apps_context_requires_dockerfile',
      sql`${t.context} IS NULL OR ${t.dockerfile} IS NOT NULL`,
    ),
  ],
);

/**
 * Per-app environment. Every value is encrypted (AAD `env:<appId>:<key>`); `secret` only
 * controls whether the API returns it.
 */
export const envVars = pgTable(
  'env_vars',
  {
    id: idColumn('env'),
    appId: text('app_id')
      .$type<AppId>()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    secret: boolean('secret').notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex('env_vars_app_id_key_key').on(t.appId, t.key)],
);
