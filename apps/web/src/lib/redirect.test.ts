import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('safeRedirect', () => {
  it('accepts same-origin paths', () => {
    expect(safeRedirect('/apps/app_1?tab=env')).toBe('/apps/app_1?tab=env');
  });

  it('rejects absolute, protocol-relative and non-string targets', () => {
    expect(safeRedirect('https://evil.example')).toBeUndefined();
    expect(safeRedirect('//evil.example')).toBeUndefined();
    expect(safeRedirect('/\\evil.example')).toBeUndefined();
    expect(safeRedirect(42)).toBeUndefined();
  });
});
