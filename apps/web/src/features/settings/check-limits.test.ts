import { describe, expect, it } from 'vitest';
import { memoryHint } from './check-limits';

describe('memoryHint', () => {
  it('shows the limit per service and what two services use together', () => {
    expect(memoryHint(2048)).toBe(
      '2.0 GiB per service: 2 services × 2.0 GiB = 4.0 GiB for a check with a database',
    );
    expect(memoryHint(8192)).toBe(
      '8.0 GiB per service: 2 services × 8.0 GiB = 16 GiB for a check with a database',
    );
  });

  it('multiplies by the checks a node runs at once', () => {
    expect(memoryHint(2048, 2)).toBe(
      '2.0 GiB per service: 2 services × 2.0 GiB = 4.0 GiB for a check with a database, 8.0 GiB for 2 at once',
    );
    expect(memoryHint(2048, 1)).toBe(memoryHint(2048));
    expect(memoryHint(2048, Number.NaN)).toBe(memoryHint(2048));
  });

  it('says nothing for a value that is not a size', () => {
    expect(memoryHint(Number.NaN)).toBeUndefined();
    expect(memoryHint(0)).toBeUndefined();
  });
});
