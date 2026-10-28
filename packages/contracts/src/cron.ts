// --- Cron schedules (scheduled checks, ADR 0020) ----------------------------------------------

/**
 * A parsed five-field cron expression (`minute hour day-of-month month day-of-week`), always read
 * in UTC. Day of month and day of week follow Vixie cron: when both are restricted (neither field
 * starts with `*`), a day matches if either does; otherwise both must match.
 */
export interface CronSchedule {
  /** Ascending. */
  readonly minutes: readonly number[];
  /** Ascending. */
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 (Sunday) to 6; 7 is read as 0. */
  readonly weekdays: ReadonlySet<number>;
  readonly dayStar: boolean;
  readonly weekdayStar: boolean;
}

export type CronParse =
  | { readonly ok: true; readonly schedule: CronSchedule }
  | { readonly ok: false; readonly error: string };

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** Index of names[0]. */
  readonly namesFrom?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  {
    name: 'month',
    min: 1,
    max: 12,
    names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
    namesFrom: 1,
  },
  {
    name: 'day of week',
    min: 0,
    max: 7,
    names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    namesFrom: 0,
  },
];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How far slots are looked for: four years and a day, so a 29 February schedule is found. */
const SEARCH_DAYS = 4 * 366 + 1;

function value(token: string, spec: FieldSpec): number | null {
  if (/^\d{1,2}$/.test(token)) {
    const number = Number(token);
    return number >= spec.min && number <= spec.max ? number : null;
  }
  const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  return index < 0 ? null : index + (spec.namesFrom ?? 0);
}

/** The values of one field (`*`, `5`, `1-5`, `*\/15`, `1-30/2`, `MON-FRI`, lists of those). */
function field(text: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const match = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(item);
    if (!match) return `${spec.name}: "${item}" is not a value, range or step`;
    const [, range = '', stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return `${spec.name}: the step of "${item}" must be at least 1`;
    let from: number | null;
    let to: number | null;
    if (range === '*') {
      from = spec.min;
      to = spec.max;
    } else {
      const bounds = range.split('-');
      if (bounds.length > 2) return `${spec.name}: "${item}" is not a value, range or step`;
      from = value(bounds[0] ?? '', spec);
      to = bounds.length === 2 ? value(bounds[1] ?? '', spec) : from;
      if (from === null || to === null) {
        return `${spec.name}: "${item}" is outside ${spec.min}-${spec.max}`;
      }
      if (from > to) return `${spec.name}: the range "${item}" runs backwards`;
      // `5/15` (a value with a step) is not cron; `5-59/15` is.
      if (bounds.length === 1 && stepText !== undefined) {
        return `${spec.name}: "${item}" needs a range or * before the step`;
      }
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** Parses `minute hour day-of-month month day-of-week` (UTC); names like MON or JAN work too. */
export function parseCron(expression: string): CronParse {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) {
    return { ok: false, error: 'Use five fields: minute hour day-of-month month day-of-week' };
  }
  const sets: Set<number>[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const parsed = field(parts[index] ?? '', spec);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    sets.push(parsed);
  }
  const [minutes, hours, days, months, weekdays] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (weekdays.delete(7)) weekdays.add(0);
  const ascending = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return {
    ok: true,
    schedule: {
      minutes: ascending(minutes),
      hours: ascending(hours),
      days,
      months,
      weekdays,
      dayStar: (parts[2] ?? '').startsWith('*'),
      weekdayStar: (parts[4] ?? '').startsWith('*'),
    },
  };
}

/** Whether the schedule runs on the UTC day that starts at `dayStart`. */
function runsOn(schedule: CronSchedule, dayStart: number): boolean {
  const date = new Date(dayStart);
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false;
  const day = schedule.days.has(date.getUTCDate());
  const weekday = schedule.weekdays.has(date.getUTCDay());
  if (schedule.dayStar || schedule.weekdayStar) return day && weekday;
  return day || weekday;
}

/** Minutes after midnight of the day's slots, ascending. */
function minutesOfDay(schedule: CronSchedule): number[] {
  return schedule.hours.flatMap((hour) => schedule.minutes.map((minute) => hour * 60 + minute));
}

/** The latest slot at or before `at` (whole minutes, UTC), or null when none in four years. */
export function cronSlotAtOrBefore(schedule: CronSchedule, at: Date): Date | null {
  const time = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  const slots = minutesOfDay(schedule).reverse();
  let dayStart = Math.floor(time / DAY_MS) * DAY_MS;
  for (let day = 0; day < SEARCH_DAYS; day += 1, dayStart -= DAY_MS) {
    if (!runsOn(schedule, dayStart)) continue;
    const limit = day === 0 ? (time - dayStart) / MINUTE_MS : 24 * 60;
    const minute = slots.find((slot) => slot <= limit);
    if (minute !== undefined) return new Date(dayStart + minute * MINUTE_MS);
  }
  return null;
}

/** The first slot after `after` (whole minutes, UTC), or null when none in four years. */
export function nextCronSlot(schedule: CronSchedule, after: Date): Date | null {
  const time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS;
  const slots = minutesOfDay(schedule);
  let dayStart = Math.floor(time / DAY_MS) * DAY_MS;
  for (let day = 0; day < SEARCH_DAYS; day += 1, dayStart += DAY_MS) {
    if (!runsOn(schedule, dayStart)) continue;
    const limit = day === 0 ? (time - dayStart) / MINUTE_MS : -1;
    const minute = slots.find((slot) => slot > limit);
    if (minute !== undefined) return new Date(dayStart + minute * MINUTE_MS);
  }
  return null;
}
