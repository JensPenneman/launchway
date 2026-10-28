import { describe, expect, it } from 'vitest';
import { CheckSchedule } from './apps.js';
import { type CronSchedule, cronSlotAtOrBefore, nextCronSlot, parseCron } from './cron.js';

function schedule(expression: string): CronSchedule {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.schedule;
}

const at = (iso: string) => new Date(iso);
const iso = (date: Date | null) => date?.toISOString() ?? null;

describe('parseCron', () => {
  it('reads values, ranges, steps, lists and names', () => {
    const parsed = schedule('5,35 */6 1-10/3 jan,JUL-AUG mon-fri');
    expect(parsed.minutes).toEqual([5, 35]);
    expect(parsed.hours).toEqual([0, 6, 12, 18]);
    expect([...parsed.days].sort((a, b) => a - b)).toEqual([1, 4, 7, 10]);
    expect([...parsed.months].sort((a, b) => a - b)).toEqual([1, 7, 8]);
    expect([...parsed.weekdays].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.dayStar).toBe(false);
    // 7 is Sunday too.
    expect([...schedule('0 0 * * 5-7').weekdays].sort()).toEqual([0, 5, 6]);
  });

  it.each([
    ['0 6 * *', 'Use five fields'],
    ['60 6 * * *', 'minute: "60" is outside 0-59'],
    ['0 24 * * *', 'hour: "24" is outside 0-23'],
    ['0 0 0 * *', 'day of month: "0" is outside 1-31'],
    ['0 0 * 13 *', 'month: "13" is outside 1-12'],
    ['0 0 * * 8', 'day of week: "8" is outside 0-7'],
    ['0 0 * * FUN', 'day of week: "FUN" is outside 0-7'],
    ['*/0 * * * *', 'minute: the step of "*/0" must be at least 1'],
    ['5/15 * * * *', 'minute: "5/15" needs a range or * before the step'],
    ['0 10-2 * * *', 'hour: the range "10-2" runs backwards'],
    ['0 1-2-3 * * *', 'hour: "1-2-3" is not a value, range or step'],
    ['0 , * * *', 'hour: "" is not a value, range or step'],
  ])('refuses %s', (expression, error) => {
    const parsed = parseCron(expression);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(error);
  });
});

describe('cron slots (UTC)', () => {
  const mondays = schedule('0 6 * * 1');

  it('finds the latest slot at or before a time', () => {
    // 2026-10-26 is a Monday.
    expect(iso(cronSlotAtOrBefore(mondays, at('2026-10-26T06:00:00Z')))).toBe(
      '2026-10-26T06:00:00.000Z',
    );
    expect(iso(cronSlotAtOrBefore(mondays, at('2026-10-26T06:00:59.999Z')))).toBe(
      '2026-10-26T06:00:00.000Z',
    );
    expect(iso(cronSlotAtOrBefore(mondays, at('2026-10-26T05:59:59Z')))).toBe(
      '2026-10-19T06:00:00.000Z',
    );
    expect(iso(cronSlotAtOrBefore(mondays, at('2026-10-28T12:00:00Z')))).toBe(
      '2026-10-26T06:00:00.000Z',
    );
  });

  it('finds the next slot after a time', () => {
    expect(iso(nextCronSlot(mondays, at('2026-10-26T06:00:00Z')))).toBe('2026-11-02T06:00:00.000Z');
    expect(iso(nextCronSlot(mondays, at('2026-10-26T05:59:00Z')))).toBe('2026-10-26T06:00:00.000Z');
    const hourly = schedule('15 * * * *');
    expect(iso(nextCronSlot(hourly, at('2026-10-26T23:20:00Z')))).toBe('2026-10-27T00:15:00.000Z');
    expect(iso(cronSlotAtOrBefore(hourly, at('2026-10-27T00:10:00Z')))).toBe(
      '2026-10-26T23:15:00.000Z',
    );
  });

  it('matches either day field when both are restricted, both when one starts with *', () => {
    // The 1st of the month or any Friday.
    const either = schedule('0 0 1 * 5');
    expect(iso(nextCronSlot(either, at('2026-10-27T00:00:00Z')))).toBe('2026-10-30T00:00:00.000Z');
    expect(iso(nextCronSlot(either, at('2026-10-31T00:00:00Z')))).toBe('2026-11-01T00:00:00.000Z');
    // Odd days that are also Fridays (`*/2` restricts days but starts with *).
    const both = schedule('0 0 */2 * 5');
    expect(iso(nextCronSlot(both, at('2026-10-27T00:00:00Z')))).toBe('2026-11-13T00:00:00.000Z');
  });

  it('finds a 29 February slot years away, and none for a day that does not exist', () => {
    expect(iso(nextCronSlot(schedule('0 0 29 2 *'), at('2026-03-01T00:00:00Z')))).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(nextCronSlot(schedule('0 0 30 2 *'), at('2026-03-01T00:00:00Z'))).toBeNull();
    expect(cronSlotAtOrBefore(schedule('0 0 31 4 *'), at('2026-03-01T00:00:00Z'))).toBeNull();
  });
});

describe('CheckSchedule', () => {
  it('takes a cron expression with one minute', () => {
    expect(CheckSchedule.parse('  0 6 * * MON ')).toBe('0 6 * * MON');
    expect(CheckSchedule.safeParse('30 */4 * * *').success).toBe(true);
  });

  it.each([
    ['*/5 * * * *', 'at most once an hour'],
    ['0,30 * * * *', 'at most once an hour'],
    ['0 0 30 2 *', 'never runs'],
    ['0 6 * *', 'five fields'],
    ['', 'Too small'],
  ])('refuses %s', (expression, error) => {
    const parsed = CheckSchedule.safeParse(expression);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(error);
  });
});
