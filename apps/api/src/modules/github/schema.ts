import { GITHUB_CONNECTION_KINDS, type GitHubConnectionId, type UserId } from '@slipway/contracts';
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps, tz } from '../../db/columns.js';
import { users } from '../users/schema.js';

export const githubConnectionKind = pgEnum('github_connection_kind', GITHUB_CONNECTION_KINDS);

/**
 * How Slipway talks to GitHub: a GitHub App created through the manifest flow (`app`) or a
 * fine-grained personal access token (`pat`). `...Encrypted` columns hold SecretBox output.
 */
export const githubConnections = pgTable(
  'github_connections',
  {
    id: idColumn('gh'),
    kind: githubConnectionKind('kind').notNull(),
    name: text('name').notNull(),
    accountLogin: text('account_login'),
    accountType: text('account_type').$type<'User' | 'Organization'>(),
    // kind = app
    appId: bigint('app_id', { mode: 'number' }),
    appSlug: text('app_slug'),
    appHtmlUrl: text('app_html_url'),
    clientId: text('client_id'),
    clientSecretEncrypted: text('client_secret_encrypted'),
    privateKeyEncrypted: text('private_key_encrypted'),
    webhookSecretEncrypted: text('webhook_secret_encrypted'),
    installationId: bigint('installation_id', { mode: 'number' }),
    // kind = pat
    tokenEncrypted: text('token_encrypted'),
    createdById: text('created_by_id')
      .$type<UserId>()
      .references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('github_connections_app_id_key').on(t.appId),
    check(
      'github_connections_credentials_present',
      sql`(${t.kind} = 'app' AND ${t.appId} IS NOT NULL AND ${t.privateKeyEncrypted} IS NOT NULL AND ${t.webhookSecretEncrypted} IS NOT NULL) OR (${t.kind} = 'pat' AND ${t.tokenEncrypted} IS NOT NULL)`,
    ),
  ],
);

/** Processed webhook deliveries (`X-GitHub-Delivery`) for replay protection. Append-only. */
export const githubWebhookDeliveries = pgTable(
  'github_webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    connectionId: text('connection_id')
      .$type<GitHubConnectionId>()
      .references(() => githubConnections.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    receivedAt: tz('received_at').notNull().defaultNow(),
  },
  (t) => [index('github_webhook_deliveries_received_at_idx').on(t.receivedAt)],
);
