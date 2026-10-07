import type {
  ForwardAuthTarget,
  Settings,
  SettingsHint,
  UpdateSettingsInput,
  UpdateSettingsResult,
} from '@launchway/contracts';
import { and, eq } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isForeignKeyViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { invalidField } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { deployments } from '../deployments/schema.js';
import { ALIASES_LOCK, assertAliasesFree, loadAttachedServices } from '../routes/attach.js';
import { settings } from './schema.js';

type SettingsRow = typeof settings.$inferSelect;

const WRITABLE_KEYS = [
  'publicUrl',
  'acmeEmail',
  'anchorHostname',
  'dynamicDnsEnabled',
  'forwardAuthUrl',
  'forwardAuthTarget',
  'edgeNodeId',
] as const satisfies readonly (keyof UpdateSettingsInput & keyof SettingsRow)[];

export interface SettingsService {
  get(): Promise<Settings>;
  /** Partial update; the answer carries follow-up hints (e.g. an app to redeploy). */
  update(input: UpdateSettingsInput, actor: RequestActor): Promise<UpdateSettingsResult>;
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
      forwardAuthTarget: row.forwardAuthTarget,
      edgeNodeId: row.edgeNodeId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Validates a new forward-auth target (the app exists, its alias is free) and returns what the
   * caller must do next: the target service is attached to the proxy network by the app's
   * deployments, so an app that did not attach it yet has to be (re)deployed.
   */
  async function checkForwardAuthTarget(
    tx: Executor,
    target: ForwardAuthTarget,
    edgeNodeId: SettingsRow['edgeNodeId'],
  ): Promise<SettingsHint[]> {
    const [app] = await tx
      .select({ id: apps.id, slug: apps.slug, nodeId: apps.nodeId })
      .from(apps)
      .where(eq(apps.id, target.appId));
    if (!app) throw invalidField('body.forwardAuthTarget.appId', 'Unknown app');
    await assertAliasesFree(tx, app, [target.service], () => 'body.forwardAuthTarget.service');

    const hints: SettingsHint[] = [];
    if (edgeNodeId !== null && app.nodeId !== edgeNodeId) {
      hints.push({
        code: 'gate-unreachable',
        appId: app.id,
        message: `App ${app.slug} does not run on the edge node, so the edge cannot reach ${target.service} by its alias. Protected routes stay offline until the app runs on the edge node.`,
      });
    }
    const [running] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.appId, app.id), eq(deployments.status, 'running')))
      .limit(1);
    const attached = (await loadAttachedServices(tx, { appId: app.id })).some(
      (entry) => entry.service === target.service,
    );
    if (!running) {
      hints.push({
        code: 'redeploy-required',
        appId: app.id,
        message: `Deploy app ${app.slug}: it has no running deployment, so ${target.service} is not on the proxy network yet.`,
      });
    } else if (!attached) {
      hints.push({
        code: 'redeploy-required',
        appId: app.id,
        message: `Redeploy app ${app.slug} to attach ${target.service} to the proxy network. Until then protected routes cannot reach the gate.`,
      });
    }
    return hints;
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
      let hints: SettingsHint[] = [];
      try {
        row = await deps.db.transaction(async (tx) => {
          if (patch.forwardAuthTarget) await tx.execute(ALIASES_LOCK);
          const before = await load(tx, true);
          const forwardAuthUrl =
            patch.forwardAuthUrl === undefined ? before.forwardAuthUrl : patch.forwardAuthUrl;
          const forwardAuthTarget =
            patch.forwardAuthTarget === undefined
              ? before.forwardAuthTarget
              : patch.forwardAuthTarget;
          if (forwardAuthUrl && forwardAuthTarget) {
            throw invalidField(
              patch.forwardAuthTarget ? 'body.forwardAuthTarget' : 'body.forwardAuthUrl',
              'Set either forwardAuthUrl or forwardAuthTarget; clear the other one with null',
            );
          }
          if (patch.forwardAuthTarget) {
            hints = await checkForwardAuthTarget(
              tx,
              patch.forwardAuthTarget,
              patch.edgeNodeId === undefined ? before.edgeNodeId : patch.edgeNodeId,
            );
          }
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
      return { ...toSettings(row), hints };
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
