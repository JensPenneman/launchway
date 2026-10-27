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

  it('says nothing for a value that is not a size', () => {
    expect(memoryHint(Number.NaN)).toBeUndefined();
    expect(memoryHint(0)).toBeUndefined();
  });
});
