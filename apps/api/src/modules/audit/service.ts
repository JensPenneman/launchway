import type { Executor } from '../../db/client.js';
import { auditActorOf, type RequestActor } from '../../lib/auth-context.js';
import { auditEvents } from './schema.js';

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
