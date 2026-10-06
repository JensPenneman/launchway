const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const dateTimeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** "3 minutes ago", "in 2 hours", "just now". */
export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return Math.abs(seconds) < 30 ? 'just now' : relativeFormat.format(seconds, 'second');
}

export function formatDateTime(value: string | null | undefined): string {
  return value ? dateTimeFormat.format(new Date(value)) : '—';
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Elapsed time between two timestamps, e.g. "1m 12s". */
export function formatDuration(from: string | null, to: string | null, now = Date.now()): string {
  if (!from) return '—';
  const end = to ? new Date(to).getTime() : now;
  const total = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
