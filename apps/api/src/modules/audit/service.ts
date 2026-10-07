import type { AuditEvent, AuditEventPage, AuditListQuery } from '@launchway/contracts';
import { and, desc, eq, getTableColumns, gte, like, lt, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { auditActorOf, type RequestActor } from '../../lib/auth-context.js';
import { afterCursor, createdAtKey, toPage } from '../../lib/pagination.js';
import { auditEvents } from './schema.js';

type AuditEventRow = typeof auditEvents.$inferSelect;

export interface AuditEntry {
  /** `<resource>.<verb>`, e.g. `settings.update`, `app.create`. */
  action: string;
  target?: { type: string; id: string | null };
  /** Diff summary (see diffSummary); never include secret values. */
  summary?: Record<string, unknown>;
}

/**
 * Writes an audit event. Call it inside the same transaction as the mutation so both commit or
 * roll back together: `db.transaction(async (tx) => { ...; await recordAudit(tx, actor, {...}) })`.
 */
export async function recordAudit(
  db: Executor,
  actor: RequestActor,
  entry: AuditEntry,
): Promise<void> {
  const who = auditActorOf(actor);
  await db.insert(auditEvents).values({
    action: entry.action,
    actorType: who.type,
    actorId: who.id,
    actorLabel: who.label,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    summary: entry.summary ?? null,
  });
}

const REDACTED = '[redacted]';

/**
 * `{ field: { from, to } }` for the given keys whose values differ. Keys in `redact` are
 * recorded as changed without their values (use it for anything secret).
 */
export function diffSummary(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
  redact: readonly string[] = [],
): Record<string, { from: unknown; to: unknown }> {
  const summary: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    summary[key] = redact.includes(key) ? { from: REDACTED, to: REDACTED } : { from, to };
  }
  return summary;
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    action: row.action,
    actor: { type: row.actorType, id: row.actorId, label: row.actorLabel },
    target: row.targetType === null ? null : { type: row.targetType, id: row.targetId },
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Escapes `%`, `_` and `\` for a LIKE prefix match. */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Audit log, newest first, keyset-paginated, with optional filters. */
export async function listAuditEvents(
  db: Executor,
  query: AuditListQuery,
): Promise<AuditEventPage> {
  const conditions: (SQL | undefined)[] = [
    query.action ? like(auditEvents.action, likePrefix(query.action)) : undefined,
    query.actorId ? eq(auditEvents.actorId, query.actorId) : undefined,
    query.targetType ? eq(auditEvents.targetType, query.targetType) : undefined,
    query.targetId ? eq(auditEvents.targetId, query.targetId) : undefined,
    query.since ? gte(auditEvents.createdAt, new Date(query.since)) : undefined,
    query.until ? lt(auditEvents.createdAt, new Date(query.until)) : undefined,
    afterCursor(query.cursor, auditEvents.createdAt, auditEvents.id, 'desc'),
  ];
  const rows = await db
    .select({ ...getTableColumns(auditEvents), createdAtKey: createdAtKey(auditEvents.createdAt) })
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(query.limit + 1);
  return toPage(rows, query.limit, toAuditEvent);
}
