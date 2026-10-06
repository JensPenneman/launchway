import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { GitHubRelease, GitHubRepo, Page } from '@slipway/contracts';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from './pagination.js';

/**
 * Thin interface over a Git host (spec section 8). GitHub is the only implementation today:
 * GitHub App installations (preferred) and fine-grained personal access tokens.
 */
export interface GitProvider {
  listRepos(
    query: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<GitHubRepo>>;
  listReleases(
    owner: string,
    repo: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<GitHubRelease>>;
  /** Newest published, non-prerelease release; null when the repository has none. */
  latestRelease(owner: string, repo: string): Promise<GitHubRelease | null>;
  /** Resolves a tag, branch or (abbreviated) commit to a full commit SHA. */
  resolveRef(owner: string, repo: string, ref: string): Promise<ResolvedRef>;
  /** HTTPS clone URL plus the `Authorization` header value for `git -c http.extraHeader`. */
  cloneCredentials(owner: string, repo: string): Promise<CloneCredentials>;
}

export interface ResolvedRef {
  readonly sha: string;
  readonly kind: 'tag' | 'branch' | 'commit';
}

export interface CloneCredentials {
  readonly cloneUrl: string;
  /** `basic <base64(x-access-token:<token>)>`; never logged or persisted. */
  readonly authorization: string;
}

export type GitProviderErrorKind = 'not-found' | 'unauthorized' | 'forbidden' | 'upstream';

/** A failed call to the Git host, classified so callers can map it to a problem. */
export class GitProviderError extends Error {
  override readonly name = 'GitProviderError';
  readonly kind: GitProviderErrorKind;
  readonly status: number | null;

  constructor(kind: GitProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface GitHubAccount {
  readonly login: string;
  readonly type: 'User' | 'Organization';
}

/** Credentials returned once by `POST /app-manifests/{code}/conversions`. */
export interface AppManifestConversion {
  readonly appId: number;
  readonly slug: string;
  readonly name: string;
  readonly htmlUrl: string;
  readonly owner: GitHubAccount | null;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret: string;
  readonly privateKey: string;
}

export interface GitHubAppCredentials {
  readonly appId: number;
  readonly privateKey: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Installation tokens live one hour; renew them 5 minutes before they expire. */
const TOKEN_RENEW_BEFORE_MS = 5 * 60 * 1000;
/** Upper bound of repositories scanned when filtering by name. */
const MAX_FILTERED_REPOS = 1000;
const USER_AGENT = 'slipway';

/** `basic <base64>` header value for HTTPS Git with a GitHub token. */
export function basicAuthorization(token: string): string {
  return `basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
}

function client(token?: string): Octokit {
  return new Octokit({
    userAgent: USER_AGENT,
    ...(token === undefined ? {} : { auth: token }),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

const requestOptions = () => ({ request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } });

function classify(error: unknown): GitProviderError {
  if (error instanceof GitProviderError) return error;
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : null;
  if (status === 404) return new GitProviderError('not-found', 'Not found on GitHub', status);
  if (status === 401) {
    return new GitProviderError('unauthorized', 'GitHub rejected the credentials', status);
  }
  if (status === 403) {
    return new GitProviderError('forbidden', 'GitHub refused the request', status);
  }
  return new GitProviderError(
    'upstream',
    status ? `GitHub answered ${status}` : 'GitHub is unreachable',
    status,
  );
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw classify(error);
  }
}

// --- Response mapping ------------------------------------------------------------------------

const RawRepo = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  default_branch: z.string().optional(),
  description: z.string().nullable().optional(),
  html_url: z.string(),
  pushed_at: z.string().nullable().optional(),
});

const RawRelease = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable().optional(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  target_commitish: z.string(),
});

const iso = (value: string | null | undefined) => (value ? new Date(value).toISOString() : null);

function toRepo(raw: unknown): GitHubRepo {
  const r = RawRepo.parse(raw);
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch ?? 'main',
    description: r.description ?? null,
    htmlUrl: r.html_url,
    pushedAt: iso(r.pushed_at),
  };
}

function toRelease(raw: unknown): GitHubRelease {
  const r = RawRelease.parse(raw);
  return {
    id: r.id,
    tagName: r.tag_name,
    name: r.name ?? null,
    draft: r.draft,
    prerelease: r.prerelease,
    publishedAt: iso(r.published_at),
    htmlUrl: r.html_url,
    body: r.body ?? null,
    targetCommitish: r.target_commitish,
  };
}

function hasNextPage(link: string | undefined): boolean {
  return link?.includes('rel="next"') ?? false;
}

const PageCursor = z.object({ p: z.number().int().min(1).max(10_000) });
const OffsetCursor = z.object({ o: z.number().int().min(0).max(MAX_FILTERED_REPOS) });

// --- Provider --------------------------------------------------------------------------------

type TokenSource = () => Promise<string>;
type RepoListing = 'installation' | 'user';

const SHA_PREFIX = /^[0-9a-f]{7,64}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function createGitHubProvider(token: TokenSource, listing: RepoListing): GitProvider {
  async function repoPage(page: number, perPage: number) {
    const octokit = client(await token());
    if (listing === 'installation') {
      const res = await octokit.request('GET /installation/repositories', {
        per_page: perPage,
        page,
        ...requestOptions(),
      });
      return {
        items: (res.data.repositories as unknown[]).map(toRepo),
        more: hasNextPage(res.headers.link),
      };
    }
    const res = await octokit.request('GET /user/repos', {
      per_page: perPage,
      page,
      sort: 'pushed',
      ...requestOptions(),
    });
    return { items: (res.data as unknown[]).map(toRepo), more: hasNextPage(res.headers.link) };
  }

  async function gitRef(owner: string, repo: string, ref: string) {
    const octokit = client(await token());
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref,
        ...requestOptions(),
      });
      return { octokit, object: res.data.object };
    } catch (error) {
      const classified = classify(error);
      if (classified.kind === 'not-found') return null;
      throw classified;
    }
  }

  return {
    listRepos: (query, cursor, limit) =>
      call(async () => {
        const needle = query?.trim().toLowerCase();
        if (!needle) {
          const page = cursor ? decodeCursor(cursor, PageCursor).p : 1;
          const { items, more } = await repoPage(page, limit);
          return { items, nextCursor: more ? encodeCursor({ p: page + 1 }) : null };
        }
        const offset = cursor ? decodeCursor(cursor, OffsetCursor).o : 0;
        const matches: GitHubRepo[] = [];
        for (let page = 1; page * 100 <= MAX_FILTERED_REPOS; page += 1) {
          const { items, more } = await repoPage(page, 100);
          matches.push(...items.filter((repo) => repo.fullName.toLowerCase().includes(needle)));
          if (!more) break;
        }
        const items = matches.slice(offset, offset + limit);
        const next = offset + limit;
        return { items, nextCursor: next < matches.length ? encodeCursor({ o: next }) : null };
      }),

    listReleases: (owner, repo, cursor, limit) =>
      call(async () => {
        const page = cursor ? decodeCursor(cursor, PageCursor).p : 1;
        const res = await client(await token()).request('GET /repos/{owner}/{repo}/releases', {
          owner,
          repo,
          per_page: limit,
          page,
          ...requestOptions(),
        });
        return {
          items: (res.data as unknown[]).map(toRelease),
          nextCursor: hasNextPage(res.headers.link) ? encodeCursor({ p: page + 1 }) : null,
        };
      }),

    latestRelease: (owner, repo) =>
      call(async () => {
        try {
          const res = await client(await token()).request(
            'GET /repos/{owner}/{repo}/releases/latest',
            { owner, repo, ...requestOptions() },
          );
          return toRelease(res.data);
        } catch (error) {
          if (classify(error).kind === 'not-found') return null;
          throw error;
        }
      }),

    resolveRef: (owner, repo, ref) =>
      call(async (): Promise<ResolvedRef> => {
        const tag = await gitRef(owner, repo, `tags/${ref}`);
        if (tag) {
          let object = tag.object;
          // Annotated tags point at a tag object; peel until the commit (bounded).
          for (let depth = 0; object.type === 'tag' && depth < 5; depth += 1) {
            const res = await tag.octokit.request('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', {
              owner,
              repo,
              tag_sha: object.sha,
              ...requestOptions(),
            });
            object = res.data.object;
          }
          if (object.type !== 'commit') {
            throw new GitProviderError('not-found', `Tag ${ref} does not point at a commit`);
          }
          return { sha: object.sha, kind: 'tag' };
        }
        const branch = await gitRef(owner, repo, `heads/${ref}`);
        if (branch) return { sha: branch.object.sha, kind: 'branch' };
        if (SHA_PREFIX.test(ref)) {
          const res = await client(await token()).request(
            'GET /repos/{owner}/{repo}/commits/{ref}',
            { owner, repo, ref, ...requestOptions() },
          );
          const sha = String(res.data.sha);
          if (FULL_SHA.test(sha)) return { sha, kind: 'commit' };
        }
        throw new GitProviderError('not-found', `Ref ${ref} not found`);
      }),

    cloneCredentials: (owner, repo) =>
      call(async () => ({
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        authorization: basicAuthorization(await token()),
      })),
  };
}

/** Provider for a fine-grained personal access token. */
export function createPatProvider(token: string): GitProvider {
  return createGitHubProvider(() => Promise.resolve(token), 'user');
}

// --- GitHub App installations ----------------------------------------------------------------

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const installationTokens = new Map<string, Promise<CachedToken>>();

function tokenCacheKey(appId: number, installationId: number): string {
  return `${appId}:${installationId}`;
}

async function installationToken(
  app: GitHubAppCredentials,
  installationId: number,
): Promise<string> {
  const key = tokenCacheKey(app.appId, installationId);
  const cached = installationTokens.get(key);
  if (cached !== undefined) {
    try {
      const entry = await cached;
      if (entry.expiresAt - TOKEN_RENEW_BEFORE_MS > Date.now()) return entry.token;
    } catch {
      // A failed fetch is retried below.
    }
    if (installationTokens.get(key) !== cached) return installationToken(app, installationId);
  }
  const pending = (async (): Promise<CachedToken> => {
    const auth = createAppAuth({ appId: app.appId, privateKey: app.privateKey });
    const result = await auth({ type: 'installation', installationId, refresh: true });
    return { token: result.token, expiresAt: Date.parse(result.expiresAt) };
  })();
  installationTokens.set(key, pending);
  try {
    return (await pending).token;
  } catch (error) {
    if (installationTokens.get(key) === pending) installationTokens.delete(key);
    throw classify(error);
  }
}

/** Drops cached installation tokens of an app (installation removed, connection deleted). */
export function forgetInstallationTokens(appId: number): void {
  for (const key of installationTokens.keys()) {
    if (key.startsWith(`${appId}:`)) installationTokens.delete(key);
  }
}

/** Provider for a GitHub App installation; tokens are cached until 5 minutes before expiry. */
export function createInstallationProvider(
  app: GitHubAppCredentials,
  installationId: number,
): GitProvider {
  return createGitHubProvider(() => installationToken(app, installationId), 'installation');
}

const RawAccount = z.object({
  login: z.string(),
  type: z.string(),
});

function toAccount(raw: unknown): GitHubAccount | null {
  const parsed = RawAccount.safeParse(raw);
  if (!parsed.success) return null;
  return {
    login: parsed.data.login,
    type: parsed.data.type === 'Organization' ? 'Organization' : 'User',
  };
}

/** `GET /user` with a token: proves the token works and names its account. */
export function verifyPatToken(token: string): Promise<GitHubAccount> {
  return call(async () => {
    const res = await client(token).request('GET /user', requestOptions());
    const account = toAccount(res.data);
    if (!account) throw new GitProviderError('upstream', 'Unexpected GitHub response');
    return account;
  });
}

const RawConversion = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string(),
  html_url: z.string(),
  owner: z.unknown().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
});

/** Exchanges the one-time manifest `code` for the new app's credentials. */
export function convertAppManifest(code: string): Promise<AppManifestConversion> {
  return call(async () => {
    const res = await client().request('POST /app-manifests/{code}/conversions', {
      code,
      ...requestOptions(),
    });
    const raw = RawConversion.parse(res.data);
    return {
      appId: raw.id,
      slug: raw.slug,
      name: raw.name,
      htmlUrl: raw.html_url,
      owner: toAccount(raw.owner),
      clientId: raw.client_id,
      clientSecret: raw.client_secret,
      webhookSecret: raw.webhook_secret,
      privateKey: raw.pem,
    };
  });
}

/**
 * Reads an installation with the app's JWT. Succeeds only for installations of this app, so it
 * also proves an `installation_id` from a redirect belongs to us.
 */
export function getAppInstallation(
  app: GitHubAppCredentials,
  installationId: number,
): Promise<{ id: number; account: GitHubAccount | null }> {
  return call(async () => {
    const auth = createAppAuth({ appId: app.appId, privateKey: app.privateKey });
    const { token } = await auth({ type: 'app' });
    const res = await client(token).request('GET /app/installations/{installation_id}', {
      installation_id: installationId,
      ...requestOptions(),
    });
    return { id: res.data.id, account: toAccount(res.data.account) };
  });
}
