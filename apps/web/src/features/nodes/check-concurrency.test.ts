import { describe, expect, it } from 'vitest';
import { parseNodeCheckConcurrency } from './check-concurrency';

describe('parseNodeCheckConcurrency', () => {
  it('reads an empty field as the platform setting', () => {
    expect(parseNodeCheckConcurrency('  ')).toEqual({ value: null, error: undefined });
  });

  it('accepts 1 to 16', () => {
    expect(parseNodeCheckConcurrency('1')).toEqual({ value: 1, error: undefined });
    expect(parseNodeCheckConcurrency(' 16 ')).toEqual({ value: 16, error: undefined });
  });

  it('refuses everything else', () => {
    for (const text of ['0', '17', '1.5', '-2', 'x']) {
      expect(parseNodeCheckConcurrency(text).error).toBeTypeOf('string');
    }
  });
});
