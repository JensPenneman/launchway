import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface FakeRelease {
  id: number;
  tag: string;
  publishedAt: string;
  draft?: boolean;
  prerelease?: boolean;
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
}

export interface FakeApp {
  id: number;
  slug: string;
  webhookSecret: string;
  privateKey: string;
  installations: Map<number, { login: string; type: 'User' | 'Organization' }>;
}

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
  /** Lifetime of issued installation tokens. */
  tokenLifetimeMs = 60 * 60 * 1000;
  readonly calls: string[] = [];
  private readonly realFetch = globalThis.fetch;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'api.github.com') return this.realFetch(input, init);
    this.calls.push(`${request.method} ${url.pathname}`);
    return this.route(request, url);
  };

  addRepo(repo: FakeRepo): FakeRepo {
    this.repos.push(repo);
    return repo;
  }

  addPat(token: string, login = 'octo'): void {
    this.patTokens.set(token, { login, type: 'User' });
  }

  addManifestCode(code: string, appId: number, slug = `slipway-test-${appId}`): void {
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
      default_branch: 'main',
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
        name: `Slipway test ${app.id}`,
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

    m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    if (m) {
      if (auth !== 'jwt') return json(401, { message: 'JWT required' });
      const installationId = Number(m[1]);
      const app = [...this.apps.values()].find((a) => a.installations.has(installationId));
      if (!app) return json(404, { message: 'Not Found' });
      if (method === 'GET' && !m[2]) {
        return json(200, { id: installationId, account: app.installations.get(installationId) });
      }
      if (method === 'POST' && m[2]) {
        const token = `ghs_${randomBytes(18).toString('hex')}`;
        this.installationTokens.set(token, installationId);
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
      const account = this.patTokens.get(header.split(' ')[1] ?? '');
      return account ? json(200, { ...account, id: 1 }) : json(403, { message: 'Forbidden' });
    }
    if (method === 'GET' && (path === '/user/repos' || path === '/installation/repositories')) {
      const all = this.repos.map((repo, index) => this.repoJson(repo, index));
      const { slice, headers } = this.page(all, url);
      return path === '/user/repos'
        ? json(200, slice, headers)
        : json(200, { total_count: all.length, repositories: slice }, headers);
    }

    m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    const repo = m ? this.repo(m[1] ?? '', m[2] ?? '') : undefined;
    if (!m || !repo || method !== 'GET') return json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';

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
    r = /^commits\/([0-9a-f]{7,64})$/.exec(rest);
    if (r) {
      const commit = repo.commits?.find((c) => c.startsWith(r?.[1] ?? '-'));
      return commit ? json(200, { sha: commit }) : json(422, { message: 'No commit found' });
    }
    return json(404, { message: 'Not Found' });
  }
}
