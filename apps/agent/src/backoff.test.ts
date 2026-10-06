import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff.js';

const options = { initialMs: 1_000, maxMs: 30_000 };

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const max = (attempt: number) => backoffDelay(attempt, options, () => 1);
    expect([0, 1, 2, 3, 4, 5, 10].map(max)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('applies jitter within [ceiling/2, ceiling]', () => {
    expect(backoffDelay(3, options, () => 0)).toBe(4_000);
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelay(4, options);
      expect(delay).toBeGreaterThanOrEqual(8_000);
      expect(delay).toBeLessThanOrEqual(16_000);
    }
  });
});
