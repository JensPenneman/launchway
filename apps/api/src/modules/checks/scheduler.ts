import { type AppId, cronSlotAtOrBefore, parseCron } from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { ProblemError } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { checksSettingsOf } from './model.js';
import { createChecksService, slotLabel } from './service.js';

/** Tries of a slot that keep failing (GitHub not answering, say) before it is used without runs. */
export const SCHEDULE_MAX_ATTEMPTS = 5;
/** Wait after the first failed try of a slot; it doubles with every further one. */
export const SCHEDULE_RETRY_MS = 60_000;

export interface CheckScheduler {
  /**
   * One pass: every app whose check schedule has a slot after its last one (at or before `now`)
   * queues its checks for the head of the default branch, once for the latest such slot (slots
   * missed while the API was down run once, late). A slot that fails is tried again after 1, 2,
   * 4 and 8 minutes; after SCHEDULE_MAX_ATTEMPTS failures it is used without runs, and the app's
   * schedule note says why.
   */
  tick(now?: Date): Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof ProblemError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : 'unknown error';
}

interface Failure {
  readonly slot: number;
  readonly count: number;
  readonly retryAt: number;
}

export function createCheckScheduler(deps: Deps): CheckScheduler {
  const logger = deps.logger.child({ component: 'check-scheduler' });
  const checks = createChecksService(deps);
  /** Failed tries per app, for its current slot (forgotten on restart, which only retries). */
  const failures = new Map<AppId, Failure>();
  return {
    async tick(now = new Date()) {
      const scheduled = await deps.db
        .select()
        .from(apps)
        .where(sql`${apps.checks}->>'schedule' IS NOT NULL`);
      for (const app of scheduled) {
        const { schedule, items } = checksSettingsOf(app);
        if (schedule === null || items.length === 0) continue;
        const parsed = parseCron(schedule);
        if (!parsed.ok) continue;
        if (app.checksLastSlot === null) {
          // A schedule set without its starting point: it starts now, so no past slot runs.
          await deps.db.execute(
            sql`UPDATE apps SET checks_last_slot = ${now} WHERE id = ${app.id} AND checks_last_slot IS NULL`,
          );
          continue;
        }
        const slot = cronSlotAtOrBefore(parsed.schedule, now);
        if (!slot || slot <= app.checksLastSlot) continue;
        const failed = failures.get(app.id);
        const previous = failed?.slot === slot.getTime() ? failed : undefined;
        if (previous && now.getTime() < previous.retryAt) continue;
        try {
          await checks.queueScheduled(app, slot, schedule);
          failures.delete(app.id);
        } catch (error) {
          const count = (previous?.count ?? 0) + 1;
          const reason = messageOf(error);
          if (count < SCHEDULE_MAX_ATTEMPTS) {
            const wait = SCHEDULE_RETRY_MS * 2 ** (count - 1);
            failures.set(app.id, { slot: slot.getTime(), count, retryAt: now.getTime() + wait });
            logger.warn(
              { appId: app.id, slot: slot.toISOString(), attempt: count, retryInMs: wait, reason },
              'queueing scheduled checks failed; trying again later',
            );
            continue;
          }
          failures.delete(app.id);
          const note = `Not queued for ${slotLabel(slot)}: ${count} tries failed (${reason})`;
          await checks.skipScheduled(app, slot, schedule, note).catch((skipError: unknown) => {
            logger.warn(
              { appId: app.id, slot: slot.toISOString(), reason: messageOf(skipError) },
              'could not record a failed slot of the check schedule',
            );
          });
        }
      }
    },
  };
}
