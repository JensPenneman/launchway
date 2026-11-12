// GitHub access of the automation. The App's write token never leaves this file: it is minted per
// call (cached by lib/git-provider.ts) and wrapped in the small set of operations below. The
// module exports operations, never a token or a client (a test enforces it).
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import {
  classifyGitHubError,
  GitProviderError,
  githubClient,
  installationAccessToken,
  installationWriteToken,
} from '../../lib/git-provider.js';
import { conflict } from '../../lib/problem.js';
import type { apps } from '../apps/schema.js';
import { appCredentials, type ConnectionRow } from '../github/providers.js';
import type {
  ClassifierCommit,
  ClassifierFile,
  ClassifierInput,
  ClassifierPolicy,
  ClassifierPullRequest,
} from './policy/classify.js';

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE = 100;
/** GitHub's caps of the commit and file lists of a pull request. */
const MAX_COMMITS = 250;
const MAX_FILES = 3000;

/** Pages of open pull requests read per pass (100 each). */
const MAX_PULL_PAGES = 10;

const requestOptionsFor = (timeoutMs: number, signal?: AbortSignal) => () => ({
  request: {
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs),
  },
});

const RawPull = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().nullish(),
  draft: z.boolean().nullish(),
  title: z.string(),
  html_url: z.string(),
  user: z.object({ id: z.number().int(), type: z.string(), login: z.string() }).nullable(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ id: z.number().int() }).nullable(),
  }),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ id: z.number().int() }) }),
  commits: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  auto_merge: z.object({ enabled_by: z.object({ login: z.string() }).nullable() }).nullish(),
  mergeable_state: z.string().nullish(),
});

const RawCommit = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    verification: z.object({ verified: z.boolean() }).nullish(),
  }),
  author: z.object({ id: z.number().int() }).nullish(),
  committer: z.object({ login: z.string() }).nullish(),
});

const RawFile = z.object({
  filename: z.string(),
  status: z.string(),
  previous_filename: z.string().nullish(),
});

const RawPulls = z.array(
  z.object({
    number: z.number().int().positive(),
    state: z.string(),
    head: z.object({ ref: z.string(), sha: z.string() }),
    auto_merge: z.object({ enabled_by: z.object({ login: z.string() }).nullable() }).nullish(),
  }),
);

/** The auto-merge request of a pull request, as GraphQL (not the REST field, which can lag) reports it. */
const AutoMergeRead = z.object({
  node: z
    .object({
      autoMergeRequest: z
        .object({ enabledBy: z.object({ login: z.string() }).nullable() })
        .nullable(),
    })
    .nullable(),
});

/** The pull request as the automation sees it. */
export interface PullDetail {
  number: number;
  nodeId: string;
  open: boolean;
  merged: boolean;
  title: string;
  url: string;
  /** Login of the pull request's author. */
  authorLogin: string;
  headSha: string;
  headRef: string;
  /** `clean`, `dirty` (a conflict), ... as GitHub reports it; null while it is being computed. */
  mergeableState: string | null;
  /** Login that turned auto-merge on; null when it is off. */
  autoMergeBy: string | null;
  classifier: ClassifierPullRequest;
  baseSha: string;
}

export interface AutomationGitHub {
  readonly repository: string;
  readonly appBotLogin: string;
  defaultBranchHead(): Promise<{ branch: string; sha: string }>;
  pull(number: number): Promise<PullDetail>;
  /** Open pull requests from `dependabot/*` branches, with who turned auto-merge on (REST, may lag). */
  openDependabotPulls(): Promise<{ number: number; autoMergeBy: string | null }[]>;
  /** Open pull requests whose head is this commit. */
  pullsWithHead(sha: string): Promise<number[]>;
  /** Everything the classifier reads for one pull request head. */
  classifierInput(pull: PullDetail, policy: ClassifierPolicy): Promise<ClassifierInput>;
  enableAutoMerge(pull: PullDetail, expectedHeadOid: string): Promise<GraphqlResult>;
  /**
   * `ok` only when GraphQL confirms that no auto-merge request exists afterwards: a refused
   * disable is re-read, never judged by its message.
   */
  disableAutoMerge(pull: PullDetail): Promise<GraphqlResult>;
  /** Who turned auto-merge on according to GraphQL (null: no request); throws when it cannot tell. */
  autoMergeBy(pull: PullDetail): Promise<string | null>;
  merge(
    number: number,
    sha: string,
  ): Promise<{ merged: true } | { refused: string; transient: boolean }>;
}

export type GraphqlResult = { ok: true } | { refused: string; message: string; transient: boolean };

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $oid: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $oid}) {
    pullRequest { number }
  }
}`;
const DISABLE_AUTO_MERGE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } }
}`;
const READ_AUTO_MERGE = `query($id: ID!) {
  node(id: $id) { ... on PullRequest { autoMergeRequest { enabledBy { __typename login } } } }
}`;

interface GraphqlError {
  type: string;
  message: string;
}

function graphqlErrors(error: unknown): GraphqlError[] | null {
  if (typeof error !== 'object' || error === null || !('errors' in error)) return null;
  const errors = (error as { errors: unknown }).errors;
  return Array.isArray(errors)
    ? errors.map((e) => ({
        type: String((e as { type?: unknown }).type ?? ''),
        message: String((e as { message?: unknown }).message ?? ''),
      }))
    : null;
}

/**
 * A login without the `[bot]` suffix REST adds: GraphQL gives a bot's login bare (`slug` where
 * REST says `slug[bot]`), so every comparison of logins goes through this.
 */
export const bareLogin = (login: string): string => login.replace(/\[bot\]$/i, '').toLowerCase();

/** GitHub answers a mutation it cannot do with HTTP 200 and `errors`; only some are answers. */
const GRAPHQL_ERROR = 'GitHub GraphQL error:';
const SETTLING = /unstable|in progress|try again|being computed|temporar|not mergeable yet/i;

async function graphql(
  octokit: Octokit,
  query: string,
  variables: object,
  options: () => object,
): Promise<GraphqlResult> {
  try {
    await octokit.graphql(query, { ...variables, ...options() });
    return { ok: true };
  } catch (error) {
    const errors = graphqlErrors(error);
    if (errors === null) throw classifyGitHubError(error);
    const message = errors
      .map((e) => e.message)
      .join('; ')
      .slice(0, 300);
    // Only UNPROCESSABLE is GitHub saying no; RATE_LIMITED, FORBIDDEN, "Something went wrong" and
    // the rest are failures that are retried.
    if (errors.length === 0 || !errors.every((e) => e.type === 'UNPROCESSABLE')) {
      throw new GitProviderError('upstream', `${GRAPHQL_ERROR} ${message}`);
    }
    return {
      refused: /clean status/i.test(message) ? 'clean-status' : 'rejected',
      message,
      transient: SETTLING.test(message),
    };
  }
}

function toDetail(raw: z.infer<typeof RawPull>): PullDetail {
  return {
    number: raw.number,
    nodeId: raw.node_id,
    open: raw.state === 'open',
    merged: raw.merged === true,
    title: raw.title,
    url: raw.html_url,
    authorLogin: raw.user?.login ?? '',
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    mergeableState: raw.mergeable_state ?? null,
    autoMergeBy: raw.auto_merge?.enabled_by?.login ?? null,
    baseSha: raw.base.sha,
    classifier: {
      authorId: raw.user?.id ?? 0,
      authorType: raw.user?.type ?? '',
      headRepoId: raw.head.repo?.id ?? null,
      baseRepoId: raw.base.repo.id,
      headRef: raw.head.ref,
      headSha: raw.head.sha,
      baseRef: raw.base.ref,
      // Filled by the caller from the repository; the base branch of the pull request otherwise.
      defaultBranch: '',
      draft: raw.draft === true,
      commitCount: raw.commits,
      changedFiles: raw.changed_files,
    },
  };
}

function isManifest(path: string): boolean {
  return path === 'package.json' || path.endsWith('/package.json');
}

/**
 * GitHub access for one app's repository, authorised with the App's single-repository write
 * token. A 409 for an app without an installed GitHub App (a PAT connection cannot write).
 */
export function createAutomationGitHub(
  deps: Pick<Deps, 'secrets'>,
  app: Pick<typeof apps.$inferSelect, 'repoOwner' | 'repoName'>,
  connection: ConnectionRow,
  options: { requestTimeoutMs?: number; signal?: AbortSignal } = {},
): AutomationGitHub {
  const { signal } = options;
  const requestOptions = requestOptionsFor(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, signal);
  if (connection.kind !== 'app' || connection.installationId === null || !connection.appSlug) {
    throw conflict('Automation needs a GitHub App connection that is installed on the account');
  }
  const credentials = appCredentials(deps, connection);
  const installationId = connection.installationId;
  const { repoOwner: owner, repoName: repo } = app;
  /** Reads use the read installation token; only the three writes below use the write token. */
  const readClient = async (): Promise<Octokit> =>
    githubClient(await installationAccessToken(credentials, installationId));
  const writeClient = async (): Promise<Octokit> =>
    githubClient(await installationWriteToken(credentials, installationId, repo));
  const call = async <T>(fn: (octokit: Octokit) => Promise<T>, write = false): Promise<T> => {
    const octokit = await (write ? writeClient() : readClient());
    // A handle past its deadline has lost its lock: nothing it still has in hand may reach GitHub.
    signal?.throwIfAborted();
    try {
      return await fn(octokit);
    } catch (error) {
      throw classifyGitHubError(error);
    }
  };

  /** Every page of the commits or files of a pull request, up to `limit` items. */
  async function pages<T>(
    path: 'commits' | 'files',
    number: number,
    schema: z.ZodType<T>,
    limit: number,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; all.length < limit; page += 1) {
      const params = {
        owner,
        repo,
        pull_number: number,
        per_page: PAGE,
        page,
        ...requestOptions(),
      };
      const data: unknown = await call(async (o) =>
        path === 'commits'
          ? (await o.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', params)).data
          : (await o.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', params)).data,
      );
      const items = z.array(schema).parse(data);
      all.push(...items);
      if (items.length < PAGE) break;
    }
    return all;
  }

  async function fileAt(path: string, ref: string): Promise<string | null> {
    try {
      const res = await call((o) =>
        o.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path,
          ref,
          headers: { accept: 'application/vnd.github.raw+json' },
          ...requestOptions(),
        }),
      );
      // Octokit parses a body that claims to be JSON (a package.json is): the classifier compares
      // parsed documents, so either form is the file.
      const data: unknown = res.data;
      if (typeof data === 'string') return data;
      return typeof data === 'object' && data !== null ? JSON.stringify(data) : null;
    } catch (error) {
      if (error instanceof GitProviderError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  let defaultBranchName: Promise<string> | undefined;
  const defaultBranch = () => {
    defaultBranchName ??= call(async (o) => {
      const res = await o.request('GET /repos/{owner}/{repo}', {
        owner,
        repo,
        ...requestOptions(),
      });
      return z.object({ default_branch: z.string().min(1) }).parse(res.data).default_branch;
    });
    return defaultBranchName;
  };

  return {
    repository: `${owner}/${repo}`,
    appBotLogin: `${connection.appSlug}[bot]`,

    async defaultBranchHead() {
      const branch = await defaultBranch();
      const res = await call((o) =>
        o.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner,
          repo,
          ref: `heads/${branch}`,
          ...requestOptions(),
        }),
      );
      return { branch, sha: z.object({ sha: z.string() }).parse(res.data.object).sha };
    },

    async pull(number) {
      const res = await call((o) =>
        o.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number: number,
          ...requestOptions(),
        }),
      );
      const detail = toDetail(RawPull.parse(res.data));
      return {
        ...detail,
        classifier: { ...detail.classifier, defaultBranch: await defaultBranch() },
      };
    },

    async openDependabotPulls() {
      const numbers: { number: number; autoMergeBy: string | null }[] = [];
      for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
        const res = await call((o) =>
          o.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: PAGE,
            page,
            ...requestOptions(),
          }),
        );
        const items = RawPulls.parse(res.data);
        for (const pull of items) {
          if (pull.head.ref.startsWith('dependabot/')) {
            numbers.push({
              number: pull.number,
              autoMergeBy: pull.auto_merge?.enabled_by?.login ?? null,
            });
          }
        }
        if (items.length < PAGE) break;
      }
      return numbers;
    },

    async pullsWithHead(sha) {
      const res = await call((o) =>
        o.request('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', {
          owner,
          repo,
          commit_sha: sha,
          per_page: PAGE,
          ...requestOptions(),
        }),
      );
      return RawPulls.parse(res.data)
        .filter((pull) => pull.state === 'open' && pull.head.sha === sha)
        .map((pull) => pull.number);
    },

    async classifierInput(pull, policy) {
      const pr = pull.classifier;
      const shaped =
        pr.authorId === policy.dependabotUserId &&
        pr.authorType === 'Bot' &&
        pr.headRepoId === pr.baseRepoId &&
        pr.headRef.startsWith('dependabot/');
      const input: ClassifierInput = {
        policy,
        pullRequest: pr,
        commits: [],
        files: [],
        packageJson: {},
      };
      // The lists are read in full, or not at all: past GitHub's caps the classifier refuses them.
      if (!shaped || pr.commitCount > MAX_COMMITS || pr.changedFiles > MAX_FILES) return input;
      const commits = await pages('commits', pull.number, RawCommit, MAX_COMMITS);
      const files = await pages('files', pull.number, RawFile, MAX_FILES);
      // A push between the calls would mix two heads: the lists count only for the head they
      // were read for.
      const again = await this.pull(pull.number);
      if (again.headSha !== pull.headSha) {
        throw new GitProviderError('upstream', 'The head moved while its files were read');
      }
      input.commits = commits.map(
        (c): ClassifierCommit => ({
          sha: c.sha,
          verified: c.commit.verification?.verified === true,
          authorId: c.author?.id ?? null,
          committerLogin: c.committer?.login ?? null,
          message: c.commit.message,
        }),
      );
      input.files = files.map(
        (f): ClassifierFile => ({
          filename: f.filename,
          status: f.status,
          previousFilename: f.previous_filename ?? null,
        }),
      );
      for (const file of input.files) {
        if (!isManifest(file.filename) || file.status !== 'modified') continue;
        input.packageJson[file.filename] = {
          base: await fileAt(file.filename, pull.baseSha),
          head: await fileAt(file.filename, pull.headSha),
        };
      }
      return input;
    },

    async enableAutoMerge(pull, expectedHeadOid) {
      const client = await writeClient();
      signal?.throwIfAborted();
      return graphql(
        client,
        ENABLE_AUTO_MERGE,
        { id: pull.nodeId, oid: expectedHeadOid },
        requestOptions,
      );
    },

    async autoMergeBy(pull) {
      const data: unknown = await call((o) =>
        o.graphql(READ_AUTO_MERGE, { id: pull.nodeId, ...requestOptions() }),
      );
      const read = AutoMergeRead.parse(data);
      if (read.node === null)
        throw new GitProviderError('upstream', 'The pull request node is gone');
      return read.node.autoMergeRequest === null
        ? null
        : bareLogin(read.node.autoMergeRequest.enabledBy?.login ?? '');
    },

    async disableAutoMerge(pull) {
      const client = await writeClient();
      signal?.throwIfAborted();
      // GitHub's answer is judged by the postcondition, whatever its type or wording: any error
      // response (never a network failure or an abort) is followed by a GraphQL read, and the
      // disable is done only when that read shows no request. A failing read throws.
      let result: GraphqlResult;
      try {
        result = await graphql(client, DISABLE_AUTO_MERGE, { id: pull.nodeId }, requestOptions);
      } catch (error) {
        if (!(error instanceof GitProviderError) || !error.message.startsWith(GRAPHQL_ERROR)) {
          throw error;
        }
        if ((await this.autoMergeBy(pull)) === null) return { ok: true };
        throw error;
      }
      if (!('refused' in result)) return result;
      return (await this.autoMergeBy(pull)) === null ? { ok: true } : result;
    },

    async merge(number, sha) {
      try {
        await call(
          (o) =>
            o.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
              owner,
              repo,
              pull_number: number,
              sha,
              merge_method: 'merge',
              ...requestOptions(),
            }),
          true,
        );
        return { merged: true };
      } catch (error) {
        // 405 (not mergeable) and 409 (the head moved) are answers; everything else is a failure.
        if (
          error instanceof GitProviderError &&
          error.status &&
          [405, 409, 422].includes(error.status)
        ) {
          return { refused: `status-${error.status}`, transient: error.status === 405 };
        }
        throw error;
      }
    },
  };
}
