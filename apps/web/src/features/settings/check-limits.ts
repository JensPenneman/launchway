import { formatBytes } from '@/lib/format';

/**
 * The memory limit per service and what a two-service check (a dev container with a database)
 * can use in total: the limit applies to every service of a check, so it multiplies.
 */
export function memoryHint(mb: number): string | undefined {
  if (!Number.isFinite(mb) || mb <= 0) return undefined;
  const bytes = mb * 1024 ** 2;
  return `${formatBytes(bytes)} per service: 2 services × ${formatBytes(bytes)} = ${formatBytes(2 * bytes)} for a check with a database`;
}
