import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomToken } from './util';

describe('randomToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the prefix and 43 base62 characters', () => {
    expect(randomToken('lwy_')).toMatch(/^lwy_[0-9A-Za-z]{43}$/);
  });

  it('draws bytes from 248 up again instead of folding them onto the first characters', () => {
    // 248 % 62 and 255 % 62 are 0 and 7: a plain modulo would turn them into '0' and '7'.
    const draws = [248, 255, 1];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(draws.shift() ?? 1);
        return array;
      },
    );
    expect(randomToken('')).toBe('1'.repeat(43));
  });
});
