import { formatBytes } from '@/lib/format';

/**
 * The memory limit per service and what a two-service check (a dev container with a database)
 * can use in total, and a node that runs `atOnce` of them: the limit applies to every service of
 * every check, so it multiplies.
 */
export function memoryHint(mb: number, atOnce = 1): string | undefined {
  if (!Number.isFinite(mb) || mb <= 0) return undefined;
  const bytes = mb * 1024 ** 2;
  const check = `${formatBytes(bytes)} per service: 2 services × ${formatBytes(bytes)} = ${formatBytes(2 * bytes)} for a check with a database`;
  const node =
    Number.isInteger(atOnce) && atOnce > 1
      ? `, ${formatBytes(2 * bytes * atOnce)} for ${atOnce} at once`
      : '';
  return check + node;
}
