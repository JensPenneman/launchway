import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface FakeRelease {
  id: number;
  tag: string;
  publishedAt: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface FakePull {
  title: string;
  state?: 'open' | 'closed';
  headRef: string;
  headSha: string;
  /** The head lives in a fork (`<forker>/<repo>`). */
  fromFork?: boolean;
  /** What the automation reads and writes: the author, the commits, the files, auto-merge. */
  auto?: FakeAutomationPull;
}

/** A pull request as the automation sees it (commits, files, contents, auto-merge). */
export interface FakeAutomationPull {
  baseSha?: string;
  /** The branch the pull request merges into (default: the default branch). */
  baseRef?: string;
  authorId?: number;
  authorType?: string;
  draft?: boolean;
  merged?: boolean;
  /** Commits of the pull request; one verified Dependabot commit when unset. */
  commits?: {
    sha: string;
    verified?: boolean;
    authorId?: number | null;
    committer?: string | null;
    message: string;
  }[];
  files?: { filename: string; status?: string; previous?: string }[];
  /** File contents by `<sha>:<path>`. */
  contents?: Record<string, string>;
  /** Who turned auto-merge on, as REST says it (`<slug>[bot]`, a user's login); null/unset: off. */
  autoMergeBy?: string | null;
  /** GraphQL answers the existing request with `enabledBy: null` (the user is gone). */
  enabledByNull?: boolean;
  /** After applying the enable the fake keeps the response for this long (a lost response). */
  enableHangsMs?: number;
  mergeableState?: string;
  /** What enabling auto-merge answers: ok, a clean-status refusal, or an error. */
  enableAnswer?: 'ok' | 'clean-status' | 'error';
  /** GraphQL errors arrive as HTTP 200 with `errors`: this one answers the enable call. */
  enableError?: { type: string; message: string };
  /** The same for `disablePullRequestAutoMerge`; unset: it succeeds. */
  disableError?: { type: string; message: string };
  /** REST keeps reading `auto_merge: null` although the request exists (GitHub's field lags). */
  restAutoMergeLag?: boolean;
  /** The GraphQL read of `autoMergeRequest` fails (HTTP 200 with an INTERNAL error). */
  readError?: boolean;
  /** `PUT .../merge` answers this status instead of merging. */
  mergeStatus?: number;
  /** The head's commit count and file count the PR object reports (default: the list lengths). */
  commitCount?: number;
  changedFiles?: number;
}

export interface FakeRepo {
  owner: string;
  name: string;
  /** Lightweight tags: tag -> commit sha. */
  tags?: Record<string, string>;
  /** Annotated tags: tag -> commit sha (served through a tag object). */
  annotatedTags?: Record<string, string>;
  branches?: Record<string, string>;
  commits?: string[];
  releases?: FakeRelease[];
  /** Pull requests by number. */
  pulls?: Record<number, FakePull>;
  /** Trees of commits (`git/commits/{sha}`); others get a tree of their own. */
  trees?: Record<string, string>;
  /** `default_branch`; main when unset. */
  defaultBranch?: string;
}

/** The tree of a commit the test did not give one: different for every commit. */
export function ownTree(commit: string): string {
  return sha(`tree-${commit.slice(0, 15)}`);
}

export interface FakeApp {
  id: number;
  slug: string;
  webhookSecret: string;
  privateKey: string;
  installations: Map<number, { login: string; type: 'User' | 'Organization' }>;
  /** What the app requests (`GET /app`); defaults to the v0.1 read-only set. */
  permissions?: Record<string, string>;
  events?: string[];
  /** What its installations approved (`GET /app/installations/{id}`); defaults to the above. */
  installationPermissions?: Record<string, string>;
  installationEvents?: string[];
}

/** A deployment created through the Deployments API, with the statuses posted to it. */
export interface FakeDeployment {
  id: number;
  repo: string;
  body: Record<string, unknown>;
  statuses: Record<string, unknown>[];
}

/** A commit status posted through `POST /repos/{owner}/{repo}/statuses/{sha}`. */
export interface FakeCommitStatus {
  repo: string;
  sha: string;
  body: Record<string, unknown>;
}

const LEGACY_PERMISSIONS = { contents: 'read', metadata: 'read' };

let keyPair: { privateKey: string } | undefined;

/** RSA key for fake GitHub Apps (generated once per process; auth-app signs real JWTs). */
export function testPrivateKey(): string {
  keyPair ??= {
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    }) as string,
  };
  return keyPair.privateKey;
}

/** Deterministic 40-character SHA for tests. */
export function sha(seed: string): string {
  return Buffer.from(seed.padEnd(20, '.').slice(0, 20), 'utf8').toString('hex');
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

/**
 * In-process stand-in for api.github.com, enough for the GitProvider, the manifest flow and app
 * installation tokens. Install it with `vi.stubGlobal('fetch', github.fetch)`; Octokit reads
 * `globalThis.fetch` per request.
 */
export class FakeGitHub {
  readonly repos: FakeRepo[] = [];
  readonly patTokens = new Map<string, { login: string; type: 'User' | 'Organization' }>();
  readonly apps = new Map<number, FakeApp>();
  /** Manifest codes -> app id created on conversion. */
  readonly manifestCodes = new Map<string, { appId: number; slug: string; owner: string }>();
  /** Installation tokens issued: token -> installation id. */
  readonly installationTokens = new Map<string, number>();
  /** Bodies of installation token requests (repository and permission limits). */
  readonly tokenRequests: unknown[] = [];
  /** `X-OAuth-Scopes` reported for classic tokens: token -> scopes. */
  readonly patScopes = new Map<string, string>();
  /** Repository requests to answer with 502 before behaving normally (GitHub outages). */
  failRepoRequests = 0;
  /** Deployments API: created deployments, and whether writes are refused (403). */
  readonly deployments: FakeDeployment[] = [];
  denyDeployments = false;
  /** Commit statuses API: posted statuses, and whether writes are refused (403). */
  readonly commitStatuses: FakeCommitStatus[] = [];
  denyStatuses = false;
  /** Lifetime of issued installation tokens. */
  tokenLifetimeMs = 60 * 60 * 1000;
  readonly calls: string[] = [];
  /** Writes of the automation: GraphQL mutations (`enablePullRequestAutoMerge ...`) and merges. */
  readonly automationWrites: string[] = [];
  /** Tokens minted with `pull_requests: write` (the automation's write token). */
  readonly writeTokens = new Set<string>();
  /** Reads of the automation that used a write token (there must be none). */
  readonly writeTokenReads: string[] = [];
  /** Holds the next request matching `match` until `release()`; `entered` resolves on arrival. */
  private gateState: { match: RegExp; entered: () => void; wait: Promise<void> } | null = null;
  /** Holds every request matching, not just the next one, until released. */
  private gateAllState: { match: RegExp; wait: Promise<void>; held: number } | null = null;
  /** Answers requests matching `match` only after `ms` (a slow GitHub). */
  delays: { match: RegExp; ms: number }[] = [];

  /** Like `gate`, but holds every matching request; `held()` counts the ones waiting. */
  gateAll(match: RegExp): { held: () => number; release: () => void } {
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { match, wait, held: 0 };
    this.gateAllState = state;
    return {
      held: () => state.held,
      release: () => {
        if (this.gateAllState === state) this.gateAllState = null;
        release();
      },
    };
  }

  gate(match: RegExp): { entered: Promise<void>; release: () => void } {
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gateState = { match, entered, wait };
    return { entered: enteredPromise, release };
  }
  private readonly realFetch = globalThis.fetch;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'api.github.com') return this.realFetch(input, init);
    this.calls.push(`${request.method} ${url.pathname}`);
    const gate = this.gateState;
    if (gate?.match.test(`${request.method} ${url.pathname}`)) {
      this.gateState = null;
      gate.entered();
      await gate.wait;
    }
    const gateAll = this.gateAllState;
    if (gateAll?.match.test(`${request.method} ${url.pathname}`)) {
      gateAll.held += 1;
      await gateAll.wait;
    }
    const delay = this.delays.find((d) => d.match.test(`${request.method} ${url.pathname}`));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay.ms));
    if (request.method === 'GET') {
      const token = (request.headers.get('authorization') ?? '').split(' ')[1] ?? '';
      if (this.writeTokens.has(token) && /\/repos\//.test(url.pathname)) {
        this.writeTokenReads.push(url.pathname);
      }
    }
    return this.route(request, url);
  };

  addRepo(repo: FakeRepo): FakeRepo {
    this.repos.push(repo);
    return repo;
  }

  addPat(token: string, login = 'octo'): void {
    this.patTokens.set(token, { login, type: 'User' });
  }

  addManifestCode(code: string, appId: number, slug = `launchway-test-${appId}`): void {
    this.manifestCodes.set(code, { appId, slug, owner: 'octo' });
  }

  private repo(owner: string, name: string): FakeRepo | undefined {
    return this.repos.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private authorized(request: Request): 'pat' | 'installation' | 'jwt' | null {
    const header = request.headers.get('authorization') ?? '';
    const [, token = ''] = header.split(' ');
    if (this.patTokens.has(token)) return 'pat';
    if (this.installationTokens.has(token)) return 'installation';
    if (token.split('.').length === 3) return 'jwt';
    return null;
  }

  private page<T>(items: T[], url: URL) {
    const perPage = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const more = page * perPage < items.length;
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    return { slice, headers: more ? { link: `<${next.toString()}>; rel="next"` } : {} };
  }

  private repoJson(repo: FakeRepo, index: number) {
    return {
      id: index + 1,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: true,
      default_branch: repo.defaultBranch ?? 'main',
      description: null,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      pushed_at: '2026-10-01T10:00:00Z',
    };
  }

  private releaseJson(repo: FakeRepo, release: FakeRelease) {
    return {
      id: release.id,
      tag_name: release.tag,
      name: release.tag,
      draft: release.draft ?? false,
      prerelease: release.prerelease ?? false,
      published_at: release.publishedAt,
      html_url: `https://github.com/${repo.owner}/${repo.name}/releases/tag/${release.tag}`,
      body: null,
      target_commitish: 'main',
    };
  }

  /** App of a JWT-authenticated request (`iss` claim). */
  private jwtApp(request: Request): FakeApp | undefined {
    const token = (request.headers.get('authorization') ?? '').split(' ')[1] ?? '';
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
      return this.apps.get(Number(claims.iss));
    } catch {
      return undefined;
    }
  }

  private async deploymentsApi(request: Request, repo: FakeRepo, rest: string) {
    const fullName = `${repo.owner}/${repo.name}`;
    if (request.method === 'GET') {
      if (rest === 'pulls') return json(200, []);
      return this.denyDeployments
        ? json(403, { message: 'Resource not accessible by integration' })
        : json(
            200,
            this.deployments.filter((d) => d.repo === fullName),
          );
    }
    if (request.method !== 'POST') return json(404, { message: 'Not Found' });
    if (this.denyDeployments) {
      return json(403, { message: 'Resource not accessible by integration' });
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (rest === 'deployments') {
      const deployment = { id: 5000 + this.deployments.length, repo: fullName, body, statuses: [] };
      this.deployments.push(deployment);
      return json(201, { id: deployment.id, ref: body.ref, environment: body.environment });
    }
    const status = /^deployments\/(\d+)\/statuses$/.exec(rest);
    const deployment = this.deployments.find((d) => d.id === Number(status?.[1]));
    if (!deployment) return json(404, { message: 'Not Found' });
    deployment.statuses.push(body);
    return json(201, { id: deployment.statuses.length, state: body.state });
  }

  /** Every commit the repository knows: listed commits, branch heads and tag targets. */
  private commitsOf(repo: FakeRepo): string[] {
    return [
      ...new Set([
        ...(repo.commits ?? []),
        ...Object.values(repo.branches ?? {}),
        ...Object.values(repo.tags ?? {}),
        ...Object.values(repo.annotatedTags ?? {}),
      ]),
    ];
  }

  private async statusesApi(request: Request, repo: FakeRepo, rest: string, url: URL) {
    const fullName = `${repo.owner}/${repo.name}`;
    const denied = () => json(403, { message: 'Resource not accessible by integration' });
    if (request.method === 'GET' && rest === 'commits') {
      const commits = this.commitsOf(repo);
      if (commits.length === 0) return json(409, { message: 'Git Repository is empty.' });
      const { slice, headers } = this.page(
        commits.map((commit) => ({ sha: commit })),
        url,
      );
      return json(200, slice, headers);
    }
    const listed = /^commits\/([^/]+)\/statuses$/.exec(rest);
    if (request.method === 'GET' && listed) {
      if (this.denyStatuses) return denied();
      return json(
        200,
        this.commitStatuses
          .filter((status) => status.repo === fullName && status.sha === listed[1])
          .map((status) => status.body)
          .reverse(),
      );
    }
    const posted = /^statuses\/([0-9a-f]{40})$/.exec(rest);
    if (request.method === 'POST' && posted) {
      if (this.denyStatuses) return denied();
      const body = (await request.json()) as Record<string, unknown>;
      this.commitStatuses.push({ repo: fullName, sha: posted[1] ?? '', body });
      return json(201, { id: this.commitStatuses.length, state: body.state });
    }
    return null;
  }

  private pullJson(repo: FakeRepo, number: number, pull: FakePull) {
    const fullName = `${repo.owner}/${repo.name}`;
    const auto = pull.auto ?? {};
    const repoId = this.repos.indexOf(repo) + 1;
    return {
      number,
      node_id: `PR_${fullName}#${number}`,
      title: pull.title,
      state: pull.state ?? 'open',
      merged: auto.merged ?? false,
      draft: auto.draft ?? false,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      user: {
        id: auto.authorId ?? 49699333,
        type: auto.authorType ?? 'Bot',
        login: 'dependabot[bot]',
      },
      head: {
        ref: pull.headRef,
        sha: pull.headSha,
        repo: pull.fromFork
          ? { id: 9_000_000 + repoId, full_name: `forker/${repo.name}` }
          : { id: repoId, full_name: fullName },
      },
      base: {
        ref: auto.baseRef ?? repo.defaultBranch ?? 'main',
        sha: auto.baseSha ?? sha('base'),
        repo: { id: repoId, full_name: fullName },
      },
      commits: auto.commitCount ?? auto.commits?.length ?? 1,
      changed_files: auto.changedFiles ?? auto.files?.length ?? 0,
      auto_merge:
        auto.autoMergeBy && !auto.restAutoMergeLag
          ? { enabled_by: { login: auto.autoMergeBy } }
          : null,
      mergeable_state: auto.mergeableState ?? 'blocked',
    };
  }

  private pullByNodeId(nodeId: string): { repo: FakeRepo; pull: FakePull; number: number } | null {
    const m = /^PR_(.+)\/(.+)#(\d+)$/.exec(nodeId);
    const repo = m ? this.repo(m[1] ?? '', m[2] ?? '') : undefined;
    const number = Number(m?.[3]);
    const pull = repo?.pulls?.[number];
    return repo && pull ? { repo, pull, number } : null;
  }

  /** `POST /graphql`: the two auto-merge mutations of the automation. */
  private async graphql(request: Request): Promise<Response> {
    const body = (await request.json()) as { query: string; variables?: Record<string, string> };
    const token = (request.headers.get('authorization') ?? '').split(' ')[1] ?? '';
    const installation = this.installationTokens.get(token);
    const app = [...this.apps.values()].find(
      (a) => installation && a.installations.has(installation),
    );
    const found = this.pullByNodeId(body.variables?.id ?? '');
    const isRead = body.query.includes('autoMergeRequest');
    if (!isRead && !this.writeTokens.has(token)) {
      return json(403, { message: 'Resource not accessible by integration' });
    }
    if (isRead && !installation) return json(401, { message: 'Bad credentials' });
    const refuse = (message: string) =>
      json(200, { data: null, errors: [{ type: 'UNPROCESSABLE', message }] });
    if (!found || !app)
      return json(200, {
        data: null,
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }],
      });
    found.pull.auto ??= {};
    const auto = found.pull.auto;
    if (isRead) {
      if (auto.readError) {
        return json(200, {
          data: null,
          errors: [
            { type: 'INTERNAL', message: 'Something went wrong while executing your query' },
          ],
        });
      }
      // GraphQL is not subject to the lag of the REST field.
      return json(200, {
        data: {
          node: {
            // GraphQL gives a bot's login without the `[bot]` REST adds.
            autoMergeRequest: auto.autoMergeBy
              ? {
                  enabledBy: auto.enabledByNull
                    ? null
                    : {
                        __typename: auto.autoMergeBy.endsWith('[bot]') ? 'Bot' : 'User',
                        login: auto.autoMergeBy.replace(/\[bot\]$/, ''),
                      },
                }
              : null,
          },
        },
      });
    }
    if (body.query.includes('enablePullRequestAutoMerge')) {
      this.automationWrites.push(
        `enablePullRequestAutoMerge #${found.number} ${body.variables?.oid}`,
      );
      if (body.variables?.oid !== found.pull.headSha) return refuse('Head branch was modified');
      if (auto.enableAnswer === 'clean-status')
        return refuse('Pull request Pull request is in clean status');
      if (auto.enableError) {
        return json(200, { data: null, errors: [auto.enableError] });
      }
      if (auto.enableAnswer === 'error') {
        return json(200, {
          data: null,
          errors: [
            { type: 'INTERNAL', message: 'Something went wrong while executing your query' },
          ],
        });
      }
      auto.autoMergeBy = `${app.slug}[bot]`;
      if (auto.enableHangsMs)
        await new Promise((resolve) => setTimeout(resolve, auto.enableHangsMs));
      return json(200, {
        data: { enablePullRequestAutoMerge: { pullRequest: { number: found.number } } },
      });
    }
    if (body.query.includes('disablePullRequestAutoMerge')) {
      this.automationWrites.push(`disablePullRequestAutoMerge #${found.number}`);
      // Refused while a request still exists, or when there is none to disable (GitHub says so
      // in words that are no contract).
      if (auto.disableError) return json(200, { data: null, errors: [auto.disableError] });
      if (!auto.autoMergeBy) {
        return refuse('Pull request Auto merge is not enabled for this pull request');
      }
      auto.autoMergeBy = null;
      return json(200, {
        data: { disablePullRequestAutoMerge: { pullRequest: { number: found.number } } },
      });
    }
    return refuse('Unknown mutation');
  }

  /** The pull request endpoints only the automation uses (lists, commits, files, merge, contents). */
  private async automationApi(
    request: Request,
    repo: FakeRepo,
    rest: string,
    url: URL,
  ): Promise<Response | null> {
    const method = request.method;
    if (method === 'GET' && rest === 'pulls') {
      const open = Object.entries(repo.pulls ?? {}).filter(
        ([, pull]) => pull.auto && (pull.state ?? 'open') === 'open',
      );
      if (open.length === 0) return null;
      return json(
        200,
        open.map(([number, pull]) => this.pullJson(repo, Number(number), pull)),
      );
    }
    let m = /^pulls\/(\d+)\/(commits|files)$/.exec(rest);
    if (method === 'GET' && m) {
      const pull = repo.pulls?.[Number(m[1])];
      if (!pull) return json(404, { message: 'Not Found' });
      const auto = pull.auto ?? {};
      if (m[2] === 'commits') {
        const commits = auto.commits ?? [
          {
            sha: pull.headSha,
            message:
              'Bump x\n\n---\nupdated-dependencies:\n- dependency-name: x\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...\n',
          },
        ];
        const { slice, headers } = this.page(
          commits.map((c) => ({
            sha: c.sha,
            commit: { message: c.message, verification: { verified: c.verified ?? true } },
            author: c.authorId === null ? null : { id: c.authorId ?? 49699333 },
            committer: c.committer === null ? null : { login: c.committer ?? 'web-flow' },
          })),
          url,
        );
        return json(200, slice, headers);
      }
      const { slice, headers } = this.page(
        (auto.files ?? []).map((f) => ({
          filename: f.filename,
          status: f.status ?? 'modified',
          ...(f.previous ? { previous_filename: f.previous } : {}),
        })),
        url,
      );
      return json(200, slice, headers);
    }
    m = /^pulls\/(\d+)\/merge$/.exec(rest);
    if (method === 'PUT' && m) {
      const number = Number(m[1]);
      const pull = repo.pulls?.[number];
      const body = (await request.json()) as { sha?: string; merge_method?: string };
      if (!pull) return json(404, { message: 'Not Found' });
      const mergeToken = (request.headers.get('authorization') ?? '').split(' ')[1] ?? '';
      if (!this.writeTokens.has(mergeToken)) {
        return json(403, { message: 'Resource not accessible by integration' });
      }
      this.automationWrites.push(`merge #${number} ${body.sha} ${body.merge_method}`);
      if (pull.auto?.mergeStatus) return json(pull.auto.mergeStatus, { message: 'Not mergeable' });
      if (body.sha !== pull.headSha) return json(409, { message: 'Head branch was modified' });
      pull.state = 'closed';
      pull.auto = { ...pull.auto, merged: true };
      return json(200, { merged: true, sha: sha('merge') });
    }
    m = /^contents\/(.+)$/.exec(rest);
    if (method === 'GET' && m) {
      const ref = url.searchParams.get('ref') ?? '';
      const text = Object.values(repo.pulls ?? {})
        .map((pull) => pull.auto?.contents?.[`${ref}:${m?.[1]}`])
        .find((value) => value !== undefined);
      return text === undefined
        ? json(404, { message: 'Not Found' })
        : new Response(text, {
            status: 200,
            headers: { 'content-type': 'application/vnd.github.raw+json' },
          });
    }
    return null;
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const path = decodeURIComponent(url.pathname);
    const method = request.method;
    let m: RegExpExecArray | null;

    m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (method === 'POST' && m) {
      const entry = this.manifestCodes.get(m[1] ?? '');
      if (!entry) return json(404, { message: 'Not Found' });
      this.manifestCodes.delete(m[1] ?? '');
      const app: FakeApp = {
        id: entry.appId,
        slug: entry.slug,
        webhookSecret: randomBytes(16).toString('hex'),
        privateKey: testPrivateKey(),
        installations: new Map(),
      };
      this.apps.set(app.id, app);
      return json(201, {
        id: app.id,
        slug: app.slug,
        name: `Launchway test ${app.id}`,
        html_url: `https://github.com/apps/${app.slug}`,
        owner: { login: entry.owner, type: 'User' },
        client_id: `Iv1.${app.id}`,
        client_secret: 'client-secret',
        webhook_secret: app.webhookSecret,
        pem: app.privateKey,
      });
    }

    const auth = this.authorized(request);
    if (!auth) return json(401, { message: 'Bad credentials' });

    if (method === 'POST' && path === '/graphql') return this.graphql(request);

    if (method === 'GET' && path === '/app') {
      if (auth !== 'jwt') return json(401, { message: 'JWT required' });
      const app = this.jwtApp(request);
      if (!app) return json(404, { message: 'Not Found' });
      return json(200, {
        id: app.id,
        slug: app.slug,
        owner: { login: 'octo', type: 'User' },
        permissions: app.permissions ?? LEGACY_PERMISSIONS,
        events: app.events ?? ['release'],
      });
    }

    m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    if (m) {
      if (auth !== 'jwt') return json(401, { message: 'JWT required' });
      const installationId = Number(m[1]);
      const app = [...this.apps.values()].find((a) => a.installations.has(installationId));
      if (!app) return json(404, { message: 'Not Found' });
      if (method === 'GET' && !m[2]) {
        return json(200, {
          id: installationId,
          account: app.installations.get(installationId),
          permissions: app.installationPermissions ?? app.permissions ?? LEGACY_PERMISSIONS,
          events: app.installationEvents ?? app.events ?? ['release'],
        });
      }
      if (method === 'POST' && m[2]) {
        const body = await request.text();
        const requested = body ? JSON.parse(body) : {};
        this.tokenRequests.push(requested);
        // GitHub refuses permissions the installation does not have.
        const granted: Record<string, string> =
          app.installationPermissions ?? app.permissions ?? LEGACY_PERMISSIONS;
        const rank = (level: string | undefined) => ['read', 'write', 'admin'].indexOf(level ?? '');
        const refused = Object.entries(
          (requested.permissions ?? {}) as Record<string, string>,
        ).filter(([name, level]) => rank(granted[name]) < rank(level));
        if (refused.length > 0) {
          return json(422, {
            message: `The permissions requested are not granted to this installation (${refused.map(([name]) => name).join(', ')}).`,
          });
        }
        const token = `ghs_${randomBytes(18).toString('hex')}`;
        this.installationTokens.set(token, installationId);
        if (requested.permissions?.pull_requests === 'write') this.writeTokens.add(token);
        return json(201, {
          token,
          expires_at: new Date(Date.now() + this.tokenLifetimeMs).toISOString(),
          permissions: { contents: 'read', metadata: 'read' },
          repository_selection: 'all',
        });
      }
    }

    if (method === 'GET' && path === '/user') {
      const header = request.headers.get('authorization') ?? '';
      const token = header.split(' ')[1] ?? '';
      const account = this.patTokens.get(token);
      const scopes = this.patScopes.get(token);
      return account
        ? json(200, { ...account, id: 1 }, scopes === undefined ? {} : { 'x-oauth-scopes': scopes })
        : json(403, { message: 'Forbidden' });
    }
    if (method === 'GET' && (path === '/user/repos' || path === '/installation/repositories')) {
      const all = this.repos.map((repo, index) => this.repoJson(repo, index));
      const { slice, headers } = this.page(all, url);
      return path === '/user/repos'
        ? json(200, slice, headers)
        : json(200, { total_count: all.length, repositories: slice }, headers);
    }

    if (path.startsWith('/repos/') && this.failRepoRequests > 0) {
      this.failRepoRequests -= 1;
      return json(502, { message: 'Server Error' });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const index = this.repos.findIndex((r) => r === this.repo(m?.[1] ?? '', m?.[2] ?? ''));
      const found = this.repos[index];
      return found ? json(200, this.repoJson(found, index)) : json(404, { message: 'Not Found' });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    const repo = m ? this.repo(m[1] ?? '', m[2] ?? '') : undefined;
    if (!m || !repo) return json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    const automation = await this.automationApi(request, repo, rest, url);
    if (automation) return automation;
    if (rest === 'deployments' || rest.startsWith('deployments/') || rest === 'pulls') {
      return this.deploymentsApi(request, repo, rest);
    }
    const statuses = await this.statusesApi(request, repo, rest, url);
    if (statuses) return statuses;
    if (method !== 'GET') return json(404, { message: 'Not Found' });

    if (rest === 'releases') {
      const all = [...(repo.releases ?? [])]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .map((release) => this.releaseJson(repo, release));
      const { slice, headers } = this.page(all, url);
      return json(200, slice, headers);
    }
    if (rest === 'releases/latest') {
      const latest = [...(repo.releases ?? [])]
        .filter((r) => !r.draft && !r.prerelease)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
      return latest
        ? json(200, this.releaseJson(repo, latest))
        : json(404, { message: 'Not Found' });
    }
    let r = /^git\/ref\/(tags|heads)\/(.+)$/.exec(rest);
    if (r) {
      const name = r[2] ?? '';
      if (r[1] === 'heads') {
        const commit = repo.branches?.[name];
        return commit
          ? json(200, { ref: `refs/heads/${name}`, object: { sha: commit, type: 'commit' } })
          : json(404, { message: 'Not Found' });
      }
      const light = repo.tags?.[name];
      if (light)
        return json(200, { ref: `refs/tags/${name}`, object: { sha: light, type: 'commit' } });
      const annotated = repo.annotatedTags?.[name];
      if (annotated) {
        return json(200, {
          ref: `refs/tags/${name}`,
          object: { sha: sha(`tagobj-${name}`), type: 'tag' },
        });
      }
      return json(404, { message: 'Not Found' });
    }
    r = /^git\/tags\/([0-9a-f]+)$/.exec(rest);
    if (r) {
      const entry = Object.entries(repo.annotatedTags ?? {}).find(
        ([name]) => sha(`tagobj-${name}`) === r?.[1],
      );
      return entry
        ? json(200, { sha: r[1], object: { sha: entry[1], type: 'commit' } })
        : json(404, { message: 'Not Found' });
    }
    r = /^pulls\/(\d+)$/.exec(rest);
    if (r) {
      const number = Number(r[1]);
      const pull = repo.pulls?.[number];
      if (!pull) return json(404, { message: 'Not Found' });
      return json(200, this.pullJson(repo, number, pull));
    }
    r = /^commits\/([0-9a-f]{40})\/pulls$/.exec(rest);
    if (r) {
      const commit = r[1] ?? '';
      const fullName = `${repo.owner}/${repo.name}`;
      return json(
        200,
        Object.entries(repo.pulls ?? {})
          .filter(([, pull]) => pull.headSha === commit)
          .map(([number, pull]) => ({
            number: Number(number),
            state: pull.state ?? 'open',
            head: {
              ref: pull.headRef,
              sha: pull.headSha,
              repo: { full_name: pull.fromFork ? `forker/${repo.name}` : fullName },
            },
            base: { ref: 'main', repo: { full_name: fullName } },
          })),
      );
    }
    r = /^git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (r) {
      const commit = r[1] ?? '';
      return json(200, { sha: commit, tree: { sha: repo.trees?.[commit] ?? ownTree(commit) } });
    }
    r = /^commits\/([0-9a-f]{7,64})$/.exec(rest);
    if (r) {
      const commit = repo.commits?.find((c) => c.startsWith(r?.[1] ?? '-'));
      return commit ? json(200, { sha: commit }) : json(422, { message: 'No commit found' });
    }
    return json(404, { message: 'Not Found' });
  }
}
