import { maskEnvVar } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { deriveSlug } from './service.js';

describe('deriveSlug', () => {
  it('turns names into URL-safe slugs', () => {
    expect(deriveSlug('My App!')).toBe('my-app');
    expect(deriveSlug('  Café  Trail  ')).toBe('cafe-trail');
    expect(deriveSlug('x'.repeat(60))).toHaveLength(40);
  });

  it('returns null for unusable or reserved names', () => {
    expect(deriveSlug('!!!')).toBeNull();
    expect(deriveSlug('Caddy')).toBeNull();
  });
});

describe('env masking', () => {
  it('hides values of secret variables only', () => {
    expect(maskEnvVar({ key: 'A', secret: true, value: 'x' }).value).toBeNull();
    expect(maskEnvVar({ key: 'A', secret: false, value: 'x' }).value).toBe('x');
  });
});
