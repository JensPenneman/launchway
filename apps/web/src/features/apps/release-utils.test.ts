import type { GitHubRelease } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { latestRelease } from './release-utils';

function release(tagName: string, flags: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    id: tagName.length,
    tagName,
    name: tagName,
    draft: false,
    prerelease: false,
    publishedAt: '2026-10-01T00:00:00.000Z',
    htmlUrl: `https://github.com/o/r/releases/tag/${tagName}`,
    body: null,
    targetCommitish: 'main',
    ...flags,
  };
}

describe('latestRelease', () => {
  it('skips drafts and prefers stable releases', () => {
    expect(
      latestRelease([
        release('v3.0.0', { draft: true }),
        release('v2.1.0-rc.1', { prerelease: true }),
        release('v2.0.0'),
      ])?.tagName,
    ).toBe('v2.0.0');
  });

  it('falls back to a prerelease and handles empty lists', () => {
    expect(latestRelease([release('v1.0.0-beta', { prerelease: true })])?.tagName).toBe(
      'v1.0.0-beta',
    );
    expect(latestRelease([])).toBeUndefined();
  });
});
