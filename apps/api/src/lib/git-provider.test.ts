import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeGitHub, sha, testPrivateKey } from '../../test/support/fake-github.js';
import {
  basicAuthorization,
  convertAppManifest,
  createInstallationProvider,
  createPatProvider,
  forgetInstallationTokens,
  GitProviderError,
  getAppInstallation,
  verifyPatToken,
} from './git-provider.js';

const PAT = `ghp_${'a'.repeat(36)}`;

describe('GitProvider (GitHub)', () => {
  let github: FakeGitHub;

  beforeEach(() => {
    github = new FakeGitHub();
    github.addPat(PAT);
    github.addRepo({
      owner: 'octo',
      name: 'trail',
      tags: { 'v1.0.0': sha('v1') },
      annotatedTags: { 'v2.0.0': sha('v2') },
      branches: { main: sha('main'), 'feature/x': sha('fx') },
      commits: [sha('c1')],
      releases: [
        { id: 1, tag: 'v1.0.0', publishedAt: '2026-01-01T00:00:00Z' },
        { id: 2, tag: 'v2.0.0', publishedAt: '2026-02-01T00:00:00Z' },
        { id: 3, tag: 'v3.0.0-rc.1', publishedAt: '2026-03-01T00:00:00Z', prerelease: true },
      ],
    });
    vi.stubGlobal('fetch', github.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the basic authorization header for HTTPS git', () => {
    expect(basicAuthorization('tok')).toBe(
      `basic ${Buffer.from('x-access-token:tok').toString('base64')}`,
    );
  });

  it('resolves lightweight tags, annotated tags, branches and commits', async () => {
    const provider = createPatProvider(PAT);
    await expect(provider.resolveRef('octo', 'trail', 'v1.0.0')).resolves.toEqual({
      sha: sha('v1'),
      kind: 'tag',
    });
    await expect(provider.resolveRef('octo', 'trail', 'v2.0.0')).resolves.toEqual({
      sha: sha('v2'),
      kind: 'tag',
    });
    await expect(provider.resolveRef('octo', 'trail', 'feature/x')).resolves.toEqual({
      sha: sha('fx'),
      kind: 'branch',
    });
    await expect(provider.resolveRef('octo', 'trail', sha('c1').slice(0, 10))).resolves.toEqual({
      sha: sha('c1'),
      kind: 'commit',
    });
  });

  it('reports unknown refs and repositories as not-found', async () => {
    const provider = createPatProvider(PAT);
    await expect(provider.resolveRef('octo', 'trail', 'nope')).rejects.toMatchObject({
      kind: 'not-found',
    });
    await expect(provider.listReleases('octo', 'missing', undefined, 10)).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });

  it('lists releases with cursor pagination and finds the latest full release', async () => {
    const provider = createPatProvider(PAT);
    const first = await provider.listReleases('octo', 'trail', undefined, 2);
    expect(first.items.map((r) => r.tagName)).toEqual(['v3.0.0-rc.1', 'v2.0.0']);
    expect(first.nextCursor).not.toBeNull();
    const second = await provider.listReleases('octo', 'trail', first.nextCursor ?? undefined, 2);
    expect(second.items.map((r) => r.tagName)).toEqual(['v1.0.0']);
    expect(second.nextCursor).toBeNull();
    expect((await provider.latestRelease('octo', 'trail'))?.tagName).toBe('v2.0.0');
  });

  it('lists and filters repositories', async () => {
    github.addRepo({ owner: 'octo', name: 'mail' });
    github.addRepo({ owner: 'octo', name: 'media' });
    const provider = createPatProvider(PAT);
    const all = await provider.listRepos(undefined, undefined, 2);
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).not.toBeNull();
    const filtered = await provider.listRepos('MA', undefined, 10);
    expect(filtered.items.map((r) => r.fullName)).toEqual(['octo/mail']);
  });

  it('verifies personal access tokens with GET /user', async () => {
    await expect(verifyPatToken(PAT)).resolves.toEqual({ login: 'octo', type: 'User' });
    const classic = `ghp_${'c'.repeat(36)}`;
    github.patTokens.set(classic, { login: 'octo', type: 'User' });
    github.patScopes.set(classic, 'repo, read:org');
    await expect(verifyPatToken(classic)).rejects.toMatchObject({ kind: 'forbidden' });
    github.patScopes.set(classic, 'read:org');
    await expect(verifyPatToken(classic)).resolves.toMatchObject({ login: 'octo' });
    await expect(verifyPatToken(`ghp_${'b'.repeat(36)}`)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  describe('GitHub App installations', () => {
    const appId = 4242;
    const installationId = 77;

    beforeEach(async () => {
      github.addManifestCode('code-1', appId);
      const conversion = await convertAppManifest('code-1');
      expect(conversion).toMatchObject({ appId, slug: `slipway-test-${appId}` });
      github.apps.get(appId)?.installations.set(installationId, { login: 'octo', type: 'User' });
      forgetInstallationTokens(appId);
    });

    it('reads installations with the app JWT', async () => {
      const credentials = { appId, privateKey: testPrivateKey() };
      await expect(getAppInstallation(credentials, installationId)).resolves.toEqual({
        id: installationId,
        account: { login: 'octo', type: 'User' },
      });
      await expect(getAppInstallation(credentials, 999)).rejects.toMatchObject({
        kind: 'not-found',
      });
    });

    it('caches installation tokens until 5 minutes before expiry', async () => {
      const provider = createInstallationProvider(
        { appId, privateKey: testPrivateKey() },
        installationId,
      );
      const tokenCalls = () =>
        github.calls.filter((call) => call.endsWith('/access_tokens')).length;

      await provider.listRepos(undefined, undefined, 10);
      await provider.listRepos(undefined, undefined, 10);
      expect(tokenCalls()).toBe(1);

      forgetInstallationTokens(appId);
      github.tokenLifetimeMs = 4 * 60 * 1000; // inside the renewal window
      await provider.listRepos(undefined, undefined, 10);
      await provider.listRepos(undefined, undefined, 10);
      expect(tokenCalls()).toBe(3);
    });

    it('hands nodes a fresh token limited to the repository and contents: read', async () => {
      const provider = createInstallationProvider(
        { appId, privateKey: testPrivateKey() },
        installationId,
      );
      await provider.listRepos(undefined, undefined, 10);
      const first = await provider.cloneCredentials('octo', 'trail');
      const second = await provider.cloneCredentials('octo', 'trail');
      expect(first.cloneUrl).toBe('https://github.com/octo/trail.git');
      expect(first.authorization).toMatch(/^basic /);
      expect(second.authorization).not.toBe(first.authorization);
      expect(github.tokenRequests.slice(-2)).toEqual([
        { repositories: ['trail'], permissions: { contents: 'read' } },
        { repositories: ['trail'], permissions: { contents: 'read' } },
      ]);
    });
  });
});
