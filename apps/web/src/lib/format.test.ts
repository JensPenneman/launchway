import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatRelative, shortSha } from './format';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

describe('format', () => {
  it('formats relative times', () => {
    expect(formatRelative('2026-10-07T11:57:00.000Z', NOW)).toBe('3 minutes ago');
    expect(formatRelative('2026-10-07T11:59:50.000Z', NOW)).toBe('just now');
    expect(formatRelative('2026-10-07T14:00:00.000Z', NOW)).toBe('in 2 hours');
    expect(formatRelative(null, NOW)).toBe('never');
  });

  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(16 * 1024 ** 3)).toBe('16 GiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatDuration('2026-10-07T11:58:48.000Z', '2026-10-07T12:00:00.000Z')).toBe('1m 12s');
    expect(formatDuration(null, null)).toBe('—');
  });

  it('shortens commit SHAs', () => {
    expect(shortSha('3f786850e387550fdab836ed7e6dc881de23001b')).toBe('3f78685');
  });
});
