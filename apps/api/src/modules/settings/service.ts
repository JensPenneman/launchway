import type { Settings, UpdateSettingsInput } from '@launchway/contracts';
import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isForeignKeyViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { invalidField } from '../../lib/problem.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { settings } from './schema.js';

type SettingsRow = typeof settings.$inferSelect;

const WRITABLE_KEYS = [
  'publicUrl',
  'acmeEmail',
  'anchorHostname',
  'dynamicDnsEnabled',
  'forwardAuthUrl',
  'edgeNodeId',
] as const satisfies readonly (keyof UpdateSettingsInput & keyof SettingsRow)[];

export interface SettingsService {
  get(): Promise<Settings>;
  update(input: UpdateSettingsInput, actor: RequestActor): Promise<Settings>;
  /**
   * Stores the detected public IPv4 (dynamic DNS) and the check time. Audited and published only
   * when the address changed.
   */
  recordPublicIpv4(
    ipv4: string,
    checkedAt: Date,
    actor: RequestActor,
  ): Promise<{ settings: Settings; previous: string | null; changed: boolean }>;
}

export function createSettingsService(
  deps: Pick<Deps, 'db' | 'config' | 'events'>,
): SettingsService {
  /** Returns the singleton row, creating it with defaults on first use. */
  async function load(db: Executor, forUpdate = false): Promise<SettingsRow> {
    await db
      .insert(settings)
      .values({ id: 1, acmeEmail: deps.config.acmeEmail })
      .onConflictDoNothing();
    const query = db.select().from(settings).where(eq(settings.id, 1));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw new Error('settings row is missing');
    return row;
  }

  function toSettings(row: SettingsRow): Settings {
    return {
      publicUrl: row.publicUrl,
      effectivePublicUrl: deps.config.publicUrl ?? row.publicUrl,
      acmeEmail: row.acmeEmail,
      anchorHostname: row.anchorHostname,
      dynamicDnsEnabled: row.dynamicDnsEnabled,
      publicIpv4: row.publicIpv4,
      publicIpv4CheckedAt: row.publicIpv4CheckedAt?.toISOString() ?? null,
      forwardAuthUrl: row.forwardAuthUrl,
      edgeNodeId: row.edgeNodeId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    async get() {
      return toSettings(await load(deps.db));
    },

    async update(input, actor) {
      const patch: Partial<Pick<SettingsRow, (typeof WRITABLE_KEYS)[number]>> = {};
      for (const key of WRITABLE_KEYS) {
        if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
      }
      if (patch.publicUrl) patch.publicUrl = new URL(patch.publicUrl).origin;

      let row: SettingsRow;
      try {
        row = await deps.db.transaction(async (tx) => {
          const before = await load(tx, true);
          const [after] = await tx
            .update(settings)
            .set(patch)
            .where(eq(settings.id, 1))
            .returning();
          if (!after) throw new Error('settings row is missing');
          await recordAudit(tx, actor, {
            action: 'settings.update',
            target: { type: 'settings', id: null },
            summary: diffSummary(before, after, Object.keys(patch)),
          });
          return after;
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw invalidField('body.edgeNodeId', 'Unknown node');
        throw error;
      }

      deps.events.publish({ topic: 'settings', action: 'updated', resourceId: null });
      return toSettings(row);
    },

    async recordPublicIpv4(ipv4, checkedAt, actor) {
      const result = await deps.db.transaction(async (tx) => {
        const before = await load(tx, true);
        const [after] = await tx
          .update(settings)
          .set({ publicIpv4: ipv4, publicIpv4CheckedAt: checkedAt })
          .where(eq(settings.id, 1))
          .returning();
        if (!after) throw new Error('settings row is missing');
        const changed = before.publicIpv4 !== after.publicIpv4;
        if (changed) {
          await recordAudit(tx, actor, {
            action: 'settings.public-ipv4',
            target: { type: 'settings', id: null },
            summary: diffSummary(before, after, ['publicIpv4']),
          });
        }
        return { row: after, previous: before.publicIpv4, changed };
      });
      if (result.changed) {
        deps.events.publish({ topic: 'settings', action: 'updated', resourceId: null });
      }
      return {
        settings: toSettings(result.row),
        previous: result.previous,
        changed: result.changed,
      };
    },
  };
}
