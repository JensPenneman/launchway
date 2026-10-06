import { describe, expect, it } from 'vitest';
import { isDomainServing } from './domains';

describe('isDomainServing', () => {
  it('treats verified and active domains as served', () => {
    expect(isDomainServing('verified')).toBe(true);
    expect(isDomainServing('active')).toBe(true);
    expect(isDomainServing('pending')).toBe(false);
    expect(isDomainServing('misconfigured')).toBe(false);
  });
});
