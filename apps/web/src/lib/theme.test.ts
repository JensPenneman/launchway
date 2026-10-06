import { describe, expect, it } from 'vitest';
import { parseThemePreference, resolveTheme } from './theme';

describe('theme', () => {
  it('falls back to the system preference for missing or unknown values', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('purple')).toBe('system');
    expect(parseThemePreference('dark')).toBe('dark');
  });

  it('resolves the system preference from the media query', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
