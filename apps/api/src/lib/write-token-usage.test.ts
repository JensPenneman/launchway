import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((file) => ({
  rel: relative(SRC, file).split(sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/** Files outside `allowed` (path prefixes or exact paths) whose text matches `pattern`. */
function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return files
    .filter(({ rel }) => !allowed.some((a) => rel === a || (a.endsWith('/') && rel.startsWith(a))))
    .filter(({ text }) => pattern.test(text))
    .map(({ rel }) => rel);
}

describe('credentials stay where they belong', () => {
  it('uses installationWriteToken only under modules/automation/ (and in lib/)', () => {
    expect(
      offenders(/\binstallationWriteToken\b/, [
        'modules/automation/',
        'lib/git-provider.ts',
        'lib/git-provider.test.ts',
        'lib/write-token-usage.test.ts',
      ]),
    ).toEqual([]);
  });

  it('never re-exports or aliases installationWriteToken outside lib/git-provider.ts', () => {
    // `export ... installationWriteToken`, `export * from '.../git-provider'`, `X as Y` aliases.
    expect(
      offenders(/\bexport\b[^;]*\binstallationWriteToken\b|\binstallationWriteToken\s+as\b/s, [
        'lib/git-provider.ts',
        'lib/write-token-usage.test.ts',
      ]),
    ).toEqual([]);
    expect(
      offenders(/\bexport\s*\*\s*from\s*['"][^'"]*git-provider(\.js)?['"]/, [
        'lib/write-token-usage.test.ts',
      ]),
    ).toEqual([]);
  });

  it('keeps the App credentials in lib/git-provider.ts', () => {
    expect(offenders(/@octokit\/auth-app|\bcreateAppAuth\b/, ['lib/git-provider.ts'])).toEqual([]);
    expect(
      offenders(/\bappJwt\b/, [
        'lib/git-provider.ts',
        'modules/github/capabilities.ts',
        'lib/write-token-usage.test.ts',
      ]),
    ).toEqual([]);
  });
});
