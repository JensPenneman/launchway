import { DEFAULT_APP_CHECKS_SETTINGS } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkTrigger,
  deletedBranch,
  pullRequestPreviewAction,
  pushedBranch,
  releasePublication,
} from './webhooks.js';

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

  it("takes the commit's tree from the head commit, when that is the pushed commit", () => {
    const tree = 'b'.repeat(40);
    const pushed = (id: string, tree_id: string) => ({
      ...push('refs/heads/main'),
      head_commit: { id, tree_id },
    });
    expect(pushedBranch(pushed(sha, tree))?.treeSha).toBe(tree);
    expect(pushedBranch(pushed('c'.repeat(40), tree))?.treeSha).toBeUndefined();
    expect(pushedBranch(pushed(sha, 'not-a-tree'))?.treeSha).toBeUndefined();
    expect(
      pushedBranch({ ...push('refs/heads/main'), head_commit: null })?.treeSha,
    ).toBeUndefined();
  });

  it('ignores tags, deletions and invalid input', () => {
    expect(pushedBranch(push('refs/tags/v1.0.0'))).toBeNull();
    expect(pushedBranch(push('refs/heads/main', '0'.repeat(40), true))).toBeNull();
    expect(pushedBranch(push('refs/heads/main', '0'.repeat(40)))).toBeNull();
    expect(pushedBranch(push('refs/heads/main', 'not-a-sha'))).toBeNull();
    expect(pushedBranch(push('refs/heads/-x'))).toBeNull();
  });
});

describe('deletedBranch', () => {
  const sha = 'a'.repeat(40);
  const zero = '0'.repeat(40);
  const deletion = (ref: string, before = sha) => ({
    ref,
    before,
    after: zero,
    deleted: true,
    repository,
  });

  it('returns the deleted branch and the commit it pointed at', () => {
    expect(deletedBranch(deletion('refs/heads/feature/x'))).toEqual({
      name: 'feature/x',
      headSha: sha,
    });
  });

  it('ignores pushes, tags and invalid input', () => {
    expect(deletedBranch({ ...deletion('refs/heads/main'), deleted: false })).toBeNull();
    expect(deletedBranch(deletion('refs/tags/v1.0.0'))).toBeNull();
    expect(deletedBranch(deletion('refs/heads/main', zero))).toBeNull();
    expect(deletedBranch(deletion('refs/heads/-x'))).toBeNull();
  });
});

describe('pullRequestPreviewAction', () => {
  const human = { login: 'octocat', type: 'User' };
  const dependabot = { login: 'dependabot[bot]', type: 'Bot' };
  const on = { enabled: true, skipBots: true, requireLabel: null };
  const labelled = { ...on, requireLabel: 'preview' };
  const pr = (
    action: string,
    options: { user?: typeof human; labels?: string[]; label?: string; state?: string } = {},
  ) => ({
    action,
    number: 7,
    ...(options.label ? { label: { name: options.label } } : {}),
    pull_request: {
      title: 'Bump vitest',
      state: options.state ?? 'open',
      user: options.user ?? human,
      labels: (options.labels ?? []).map((name) => ({ name })),
      head: { ref: 'deps/vitest', sha: 'a'.repeat(40), repo: { full_name: 'octo/trail' } },
      base: { repo: { full_name: 'octo/trail' } },
    },
    repository,
  });

  it('opens or updates previews of pull requests by people', () => {
    for (const action of ['opened', 'reopened', 'synchronize']) {
      expect(pullRequestPreviewAction(pr(action), on)).toEqual({ kind: 'open' });
    }
    expect(pullRequestPreviewAction(pr('opened'), { ...on, enabled: false })).toEqual({
      kind: 'ignore',
      reason: 'previews are off for the app',
    });
    expect(pullRequestPreviewAction(pr('edited'), on)).toEqual({ kind: 'ignore' });
  });

  it('skips bot authors unless skipBots is off', () => {
    expect(pullRequestPreviewAction(pr('opened', { user: dependabot }), on)).toEqual({
      kind: 'ignore',
      reason: 'opened by the bot dependabot[bot]',
    });
    const renovate = { login: 'renovate[bot]', type: 'User' };
    expect(pullRequestPreviewAction(pr('synchronize', { user: renovate }), on).kind).toBe('ignore');
    expect(
      pullRequestPreviewAction(pr('opened', { user: dependabot }), { ...on, skipBots: false }),
    ).toEqual({ kind: 'open' });
  });

  it('requires the label, matched like GitHub without regard to case', () => {
    expect(pullRequestPreviewAction(pr('opened', { labels: ['bug'] }), labelled)).toEqual({
      kind: 'ignore',
      reason: 'lacks the label preview',
    });
    expect(pullRequestPreviewAction(pr('synchronize', { labels: ['Preview'] }), labelled)).toEqual({
      kind: 'open',
    });
  });

  it('opens the preview when the pull request gains the required label', () => {
    const gained = pr('labeled', { label: 'preview', labels: ['preview'] });
    expect(pullRequestPreviewAction(gained, labelled)).toEqual({ kind: 'open' });
    expect(pullRequestPreviewAction(pr('labeled', { label: 'bug' }), labelled)).toEqual({
      kind: 'ignore',
    });
    expect(pullRequestPreviewAction(gained, on)).toEqual({ kind: 'ignore' });
    expect(
      pullRequestPreviewAction(pr('labeled', { label: 'preview', state: 'closed' }), labelled),
    ).toEqual({ kind: 'ignore' });
    expect(
      pullRequestPreviewAction(pr('labeled', { label: 'preview', user: dependabot }), labelled)
        .kind,
    ).toBe('ignore');
  });

  it('closes the preview when the pull request loses the required label or closes', () => {
    expect(pullRequestPreviewAction(pr('unlabeled', { label: 'Preview' }), labelled)).toEqual({
      kind: 'close',
    });
    expect(pullRequestPreviewAction(pr('unlabeled', { label: 'bug' }), labelled)).toEqual({
      kind: 'ignore',
    });
    expect(pullRequestPreviewAction(pr('unlabeled', { label: 'preview' }), on)).toEqual({
      kind: 'ignore',
    });
    // Closing ignores the filters: a preview opened by hand closes with its pull request.
    expect(
      pullRequestPreviewAction(pr('closed', { user: dependabot }), { ...labelled, enabled: false }),
    ).toEqual({ kind: 'close' });
  });
});

describe('checkTrigger', () => {
  const human = { login: 'octocat', type: 'User' };
  const dependabot = { login: 'dependabot[bot]', type: 'Bot' };
  const quality = { name: 'quality', command: 'npm test', service: 'dev', timeoutMinutes: 30 };
  const on = { ...DEFAULT_APP_CHECKS_SETTINGS, enabled: true, items: [quality] };
  const push = (branch: string, sender: typeof human | null = human) =>
    ({ kind: 'push', branch, sender }) as const;
  const pr = (baseBranch: string | null, author: typeof human | null = human) =>
    ({ kind: 'pull_request', baseBranch, author }) as const;

  it('runs the checks of every push and pull request by default', () => {
    expect(checkTrigger(on, push('feature/x'))).toEqual({ run: true });
    expect(checkTrigger(on, pr('main'))).toEqual({ run: true });
    expect(checkTrigger(on, push('main', null))).toEqual({ run: true });
  });

  it('needs checks on and at least one check', () => {
    expect(checkTrigger({ ...on, enabled: false }, push('main'))).toEqual({
      run: false,
      reason: 'checks are off for the app',
    });
    expect(checkTrigger({ ...on, items: [] }, pr('main'))).toEqual({
      run: false,
      reason: 'the app has no checks',
    });
  });

  it('filters pushes on the pushed branch and pull requests on their base branch', () => {
    const main = { ...on, branches: ['main', 'release/1.x'] };
    expect(checkTrigger(main, push('main'))).toEqual({ run: true });
    expect(checkTrigger(main, push('release/1.x'))).toEqual({ run: true });
    expect(checkTrigger(main, push('feature/x'))).toEqual({
      run: false,
      reason: 'pushes to feature/x run no checks',
    });
    // Exact names: GitHub branch names are case-sensitive.
    expect(checkTrigger(main, push('Main')).run).toBe(false);
    expect(checkTrigger(main, pr('main'))).toEqual({ run: true });
    expect(checkTrigger(main, pr('develop'))).toEqual({
      run: false,
      reason: 'pull requests into develop run no checks',
    });
    expect(checkTrigger(main, pr(null))).toEqual({
      run: false,
      reason: 'pull requests into an unnamed base branch run no checks',
    });
    expect(checkTrigger(on, pr(null))).toEqual({ run: true });
  });

  it('skips pushes and pull requests of bots with skipBots', () => {
    const skip = { ...on, skipBots: true };
    expect(checkTrigger(skip, push('main', dependabot))).toEqual({
      run: false,
      reason: 'pushed by the bot dependabot[bot]',
    });
    expect(checkTrigger(skip, pr('main', { login: 'renovate[bot]', type: 'User' }))).toEqual({
      run: false,
      reason: 'opened by the bot renovate[bot]',
    });
    expect(checkTrigger(skip, push('main', human))).toEqual({ run: true });
    expect(checkTrigger(on, push('main', dependabot))).toEqual({ run: true });
  });
});
