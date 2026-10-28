import { cronSlotAtOrBefore, parseCron } from '@launchway/contracts';
import { sql } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { ProblemError } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { checksSettingsOf } from './model.js';
import { createChecksService } from './service.js';

export interface CheckScheduler {
  /**
   * One pass: every app whose check schedule has a slot after its last one (at or before `now`)
   * queues its checks for the head of the default branch, once for the latest such slot (slots
   * missed while the API was down run once, late). Failures are logged; the slot is tried again
   * on the next pass.
   */
  tick(now?: Date): Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof ProblemError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : 'unknown error';
}

export function createCheckScheduler(deps: Deps): CheckScheduler {
  const logger = deps.logger.child({ component: 'check-scheduler' });
  const checks = createChecksService(deps);
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
        try {
          await checks.queueScheduled(app, slot, schedule);
        } catch (error) {
          logger.warn(
            { appId: app.id, slot: slot.toISOString(), reason: messageOf(error) },
            'queueing scheduled checks failed; the next pass tries again',
          );
        }
      }
    },
  };
}
