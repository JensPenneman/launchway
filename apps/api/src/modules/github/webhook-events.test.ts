import { describe, expect, it } from 'vitest';
import { pushedBranch, releasePublication } from './webhooks.js';

const repository = { name: 'trail', owner: { login: 'octo' } };
const release = (
  action: string,
  flags: { draft?: boolean; prerelease?: boolean } = {},
  changes?: Record<string, unknown>,
) => ({
  action,
  release: { tag_name: 'v1.2.0', draft: false, prerelease: false, ...flags },
  ...(changes ? { changes } : {}),
  repository,
});

describe('releasePublication', () => {
  it('deploys published and released releases', () => {
    expect(releasePublication(release('published'))).toEqual({ tag: 'v1.2.0', prerelease: false });
    expect(releasePublication(release('released'))).toEqual({ tag: 'v1.2.0', prerelease: false });
  });

  it('deploys an edit only when it publishes a draft', () => {
    expect(releasePublication(release('edited', {}, { draft: { from: true } }))).toEqual({
      tag: 'v1.2.0',
      prerelease: false,
    });
    expect(releasePublication(release('edited', {}, { body: { from: 'old notes' } }))).toBeNull();
    expect(releasePublication(release('edited'))).toBeNull();
  });

  it('never deploys drafts or other actions', () => {
    expect(releasePublication(release('created', { draft: true }))).toBeNull();
    expect(releasePublication(release('published', { draft: true }))).toBeNull();
    expect(
      releasePublication(release('edited', { draft: true }, { draft: { from: true } })),
    ).toBeNull();
    expect(releasePublication(release('deleted'))).toBeNull();
    expect(releasePublication(release('unpublished'))).toBeNull();
  });

  it('flags prereleases for the per-app opt-in', () => {
    expect(releasePublication(release('published', { prerelease: true }))).toEqual({
      tag: 'v1.2.0',
      prerelease: true,
    });
  });
});

describe('pushedBranch', () => {
  const sha = 'a'.repeat(40);
  const push = (ref: string, after = sha, deleted = false) => ({ ref, after, deleted, repository });

  it('returns the branch and pushed commit', () => {
    expect(pushedBranch(push('refs/heads/main'))).toEqual({ branch: 'main', commitSha: sha });
    expect(pushedBranch(push('refs/heads/release/1.x'))).toEqual({
      branch: 'release/1.x',
      commitSha: sha,
    });
  });

  it('ignores tags, deletions and invalid input', () => {
    expect(pushedBranch(push('refs/tags/v1.0.0'))).toBeNull();
    expect(pushedBranch(push('refs/heads/main', '0'.repeat(40), true))).toBeNull();
    expect(pushedBranch(push('refs/heads/main', '0'.repeat(40)))).toBeNull();
    expect(pushedBranch(push('refs/heads/main', 'not-a-sha'))).toBeNull();
    expect(pushedBranch(push('refs/heads/-x'))).toBeNull();
  });
});
