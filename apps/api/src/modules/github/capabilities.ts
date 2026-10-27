import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  GITHUB_CAPABILITIES_TTL_MS,
  type GitHubConnectionCapabilities,
  type GitHubConnectionId,
} from '@launchway/contracts';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { appJwt, classifyGitHubError } from '../../lib/git-provider.js';
import { apps } from '../apps/schema.js';
import {
  errorStatus,
  type OctokitLike,
  type OctokitResponse,
  requestWithRetry,
  toOctokitLike,
} from './octokit.js';
import {
  appCredentials,
  type ConnectionRow,
  getConnection,
  secretContext,
  toGitProblem,
} from './providers.js';
import {
  type CheckedCapabilities,
  DENIAL_LOG_INTERVAL_MS,
  githubConnectionState,
} from './state.js';

type Level = 'read' | 'write';
type Grants = Readonly<Record<string, string | undefined>>;

const PAT_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens';

const RawAccount = z.object({ login: z.string(), type: z.string() }).nullish();
const RawApp = z.object({
  slug: z.string().min(1),
  owner: RawAccount,
  permissions: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default([]),
});
const RawInstallation = z.object({
  id: z.number().int().positive(),
  account: RawAccount,
  permissions: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default([]),
});
const RawRepos = z.array(z.object({ name: z.string(), owner: z.object({ login: z.string() }) }));
const RawCommits = z.array(z.object({ sha: z.string().min(1) }));

function satisfies(granted: string | undefined, wanted: Level): boolean {
  return wanted === 'read' ? granted === 'read' || granted === 'write' : granted === 'write';
}

/** `deployments: write` / `statuses: write` / `event: pull_request` entries the grants lack. */
export function missingGrants(permissions: Grants, events: readonly string[]): string[] {
  const missing: string[] = [];
  for (const [name, level] of Object.entries(GITHUB_APP_PERMISSIONS)) {
    if (!satisfies(permissions[name], level)) missing.push(`${name}: ${level}`);
  }
  for (const event of GITHUB_APP_EVENTS) {
    if (!events.includes(event)) missing.push(`event: ${event}`);
  }
  return missing;
}

function accountPath(account: { login: string; type: string } | null | undefined): string {
  return account?.type === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings`
    : 'https://github.com/settings';
}

export interface AppGrants {
  readonly app: z.infer<typeof RawApp>;
  /** Null while the app is not installed. */
  readonly installation: z.infer<typeof RawInstallation> | null;
}

/**
 * Capabilities of a GitHub App connection from `GET /app` (what the app requests) and its
 * installation (what the account approved; that is what tokens get).
 */
export function appCapabilities(
  connectionId: GitHubConnectionId,
  grants: AppGrants,
  checkedAt: Date,
): CheckedCapabilities {
  const effective = grants.installation ?? grants.app;
  const missing = missingGrants(effective.permissions, effective.events);
  const appMissing = missingGrants(grants.app.permissions, grants.app.events);
  return {
    connectionId,
    kind: 'app',
    deployments: satisfies(effective.permissions.deployments, 'write'),
    pullRequests: satisfies(effective.permissions.pull_requests, 'read'),
    statuses: satisfies(effective.permissions.statuses, 'write'),
    events: [...effective.events].sort(),
    missing,
    pendingApproval: grants.installation !== null && missing.length > 0 && appMissing.length === 0,
    settingsUrl: `${accountPath(grants.app.owner)}/apps/${encodeURIComponent(grants.app.slug)}/permissions`,
    installationSettingsUrl: grants.installation
      ? `${accountPath(grants.installation.account)}/installations/${grants.installation.id}`
      : null,
    probedRepository: null,
    checkedAt: checkedAt.toISOString(),
  };
}

export interface CapabilitiesOptions {
  /** Client authenticated with the app JWT of a GitHub App connection. */
  readonly appClientFor?: (row: ConnectionRow) => Promise<OctokitLike>;
  /** Client authenticated with the token of a PAT connection. */
  readonly patClientFor?: (row: ConnectionRow) => OctokitLike;
  readonly now?: () => number;
}

export interface CapabilitiesService {
  get(
    id: GitHubConnectionId,
    options?: { refresh?: boolean },
  ): Promise<GitHubConnectionCapabilities>;
}

export function createCapabilitiesService(
  deps: Pick<Deps, 'db' | 'secrets' | 'events'>,
  options: CapabilitiesOptions = {},
): CapabilitiesService {
  const now = options.now ?? Date.now;
  const retry = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now };
  const shared = githubConnectionState(deps.events);
  const appClientFor =
    options.appClientFor ??
    (async (row: ConnectionRow) => toOctokitLike(await appJwt(appCredentials(deps, row))));
  const patClientFor =
    options.patClientFor ??
    ((row: ConnectionRow) => {
      if (row.tokenEncrypted === null) throw new Error(`connection ${row.id} has no token`);
      return toOctokitLike(deps.secrets.decrypt(row.tokenEncrypted, secretContext.token(row.id)));
    });

  const request = (client: OctokitLike, route: string, params: Record<string, unknown> = {}) =>
    requestWithRetry(client, route, params, retry);

  /** True when the probe succeeds, false when GitHub refuses it (403/404). */
  async function probe(client: OctokitLike, route: string, params: Record<string, unknown>) {
    try {
      await request(client, route, params);
      return true;
    } catch (error) {
      const status = errorStatus(error);
      if (status === 403 || status === 404) return false;
      throw error;
    }
  }

  async function checkApp(row: ConnectionRow): Promise<CheckedCapabilities> {
    const client = await appClientFor(row);
    const app = RawApp.parse((await request(client, 'GET /app')).data);
    const installation =
      row.installationId === null
        ? null
        : RawInstallation.parse(
            (
              await request(client, 'GET /app/installations/{installation_id}', {
                installation_id: row.installationId,
              })
            ).data,
          );
    return appCapabilities(row.id, { app, installation }, new Date(now()));
  }

  /**
   * Commit statuses of the newest commit of the repository; false without a commit (an empty
   * repository answers 409).
   */
  async function probeStatuses(client: OctokitLike, repo: { owner: string; name: string }) {
    let commits: OctokitResponse;
    try {
      commits = await request(client, 'GET /repos/{owner}/{repo}/commits', {
        owner: repo.owner,
        repo: repo.name,
        per_page: 1,
      });
    } catch (error) {
      const status = errorStatus(error);
      if (status === 403 || status === 404 || status === 409) return false;
      throw error;
    }
    const parsed = RawCommits.safeParse(commits.data);
    const sha = parsed.success ? parsed.data[0]?.sha : undefined;
    if (!sha) return false;
    return probe(client, 'GET /repos/{owner}/{repo}/commits/{ref}/statuses', {
      owner: repo.owner,
      repo: repo.name,
      ref: sha,
      per_page: 1,
    });
  }

  /**
   * Tokens do not list their permissions: probe reads of deployments, pull requests and commit
   * statuses on a repository of the connection. Write access to deployments and statuses only
   * shows when the mirrors try.
   */
  async function checkPat(row: ConnectionRow): Promise<CheckedCapabilities> {
    const client = patClientFor(row);
    const user = await request(client, 'GET /user');
    // Classic tokens report scopes; Launchway only accepts read-only ones, which cannot deploy.
    const classic = user.headers['x-oauth-scopes'] !== undefined;
    const [app] = await deps.db
      .select({ owner: apps.repoOwner, name: apps.repoName })
      .from(apps)
      .where(eq(apps.connectionId, row.id))
      .orderBy(asc(apps.createdAt))
      .limit(1);
    let repo = app ?? null;
    if (!repo) {
      const repos = RawRepos.parse(
        (await request(client, 'GET /user/repos', { per_page: 1, sort: 'pushed' })).data,
      );
      repo = repos[0] ? { owner: repos[0].owner.login, name: repos[0].name } : null;
    }
    let deployments = false;
    let pullRequests = false;
    let statuses = false;
    if (repo) {
      const params = { owner: repo.owner, repo: repo.name, per_page: 1 };
      deployments =
        !classic && (await probe(client, 'GET /repos/{owner}/{repo}/deployments', params));
      pullRequests = await probe(client, 'GET /repos/{owner}/{repo}/pulls', {
        ...params,
        state: 'all',
      });
      statuses = !classic && (await probeStatuses(client, repo));
    }
    const missing: string[] = [];
    if (!deployments) missing.push('deployments: write');
    if (!pullRequests) missing.push('pull_requests: read');
    if (!statuses) missing.push('statuses: write');
    return {
      connectionId: row.id,
      kind: 'pat',
      deployments,
      pullRequests,
      statuses,
      events: [],
      missing,
      pendingApproval: false,
      settingsUrl: PAT_SETTINGS_URL,
      installationSettingsUrl: null,
      probedRepository: repo ? `${repo.owner}/${repo.name}` : null,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  return {
    async get(id, { refresh = false } = {}) {
      const row = await getConnection(deps.db, id);
      const cached = shared.capabilities.get(id);
      let checked: CheckedCapabilities;
      if (!refresh && cached && cached.expiresAt > now()) {
        checked = cached.value;
      } else {
        try {
          checked = row.kind === 'app' ? await checkApp(row) : await checkPat(row);
        } catch (error) {
          throw toGitProblem(classifyGitHubError(error));
        }
        shared.capabilities.set(id, {
          value: checked,
          expiresAt: now() + GITHUB_CAPABILITIES_TTL_MS,
        });
      }
      const recent = (at: number | undefined) =>
        at !== undefined && now() - at < DENIAL_LOG_INTERVAL_MS;
      const denial = shared.denials.get(id);
      if (row.kind === 'pat' && recent(denial?.at) && checked.deployments) {
        // The read probe passed, but GitHub refused to write a deployment.
        checked = {
          ...checked,
          deployments: false,
          missing: ['deployments: write', ...checked.missing],
        };
      }
      const statusDenial = shared.statusDenials.get(id);
      if (row.kind === 'pat' && recent(statusDenial?.at) && checked.statuses) {
        // Statuses could be read, but GitHub refused to write one.
        checked = { ...checked, statuses: false, missing: [...checked.missing, 'statuses: write'] };
      }
      const isoOf = (at: number | undefined) =>
        at === undefined ? null : new Date(at).toISOString();
      return {
        ...checked,
        lastDeniedAt: isoOf(denial?.at),
        lastStatusDeniedAt: isoOf(statusDenial?.at),
      };
    },
  };
}
