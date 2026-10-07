import { describe, expect, it } from 'vitest';
import { parseDotenv } from '@/lib/dotenv';
import { formatDotenv } from './previews-env';

describe('formatDotenv', () => {
  it('writes sorted KEY=value lines that parse back to the same values', () => {
    const values = {
      URL: '{{previewUrl}}',
      DB: 'app_pr_{{prNumber}}',
      SPACED: 'two words',
      QUOTED: 'say "hi" # not a comment',
      EMPTY: '',
    };
    const text = formatDotenv(values);
    expect(text.split('\n')[0]).toBe('DB=app_pr_{{prNumber}}');
    const parsed = parseDotenv(text);
    expect(parsed.errors).toEqual([]);
    expect(Object.fromEntries(parsed.entries.map((e) => [e.key, e.value]))).toEqual(values);
  });
});
