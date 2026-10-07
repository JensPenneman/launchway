import { AUDIT_ACTOR_TYPES } from '@launchway/contracts';
import { index, inet, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { idColumn, tz } from '../../db/columns.js';

export const auditActorType = pgEnum('audit_actor_type', AUDIT_ACTOR_TYPES);

/**
 * Who changed what, when, from where. Append-only (no updated_at). Actor/target ids are not
 * foreign keys so history survives deletions; `actorLabel` snapshots the name/e-mail.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: idColumn('aud'),
    action: text('action').notNull(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    /** Diff summary; never secret values. */
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_created_at_idx').on(t.createdAt.desc()),
    index('audit_events_target_idx').on(t.targetType, t.targetId),
    index('audit_events_actor_id_idx').on(t.actorId),
  ],
);
