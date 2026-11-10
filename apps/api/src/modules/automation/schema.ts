import {
  type AppId,
  AUTOMATION_RUN_KINDS,
  type AutomationActionRecord,
} from '@launchway/contracts';
import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, timestamps } from '../../db/columns.js';
import { apps } from '../apps/schema.js';

/**
 * One row per automated subject of an app (ADR 0023): a Dependabot pull request (`pr-<number>`)
 * or a release train (L5). The executor's single table: what the automation saw (`snapshot`),
 * what it decided and what each action returned (`actions`, in order, each with its idempotency
 * key), so a restart or a redelivery resumes instead of repeating.
 */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: idColumn('run'),
    appId: text('app_id')
      .$type<AppId>()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: AUTOMATION_RUN_KINDS }).notNull(),
    key: text('key').notNull(),
    state: text('state').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    actions: jsonb('actions').$type<AutomationActionRecord[]>().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('automation_runs_app_id_kind_key_key').on(t.appId, t.kind, t.key),
    index('automation_runs_app_id_updated_at_idx').on(t.appId, t.updatedAt.desc()),
  ],
);
