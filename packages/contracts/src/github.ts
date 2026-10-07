import { CommitSha, DisplayName, Timestamp } from './common.js';
import { GitHubConnectionId } from './ids.js';
import { list, PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

export const GITHUB_CONNECTION_KINDS = ['app', 'pat'] as const;
export const GitHubConnectionKind = z
  .enum(GITHUB_CONNECTION_KINDS)
  .openapi('GitHubConnectionKind', {
    description:
      'app: GitHub App created through the manifest flow (preferred); pat: fine-grained token',
  });
export type GitHubConnectionKind = z.infer<typeof GitHubConnectionKind>;

/** Webhook events Launchway handles (spec section 8). */
export const GITHUB_WEBHOOK_EVENTS = [
  'ping',
  'release',
  'push',
  'pull_request',
  'installation',
  'installation_repositories',
] as const;
/**
 * Permissions/events requested by the generated GitHub App. `deployments: write` mirrors Launchway
 * deployments to GitHub's Deployments API; `pull_requests: read` and the `pull_request` event serve
 * preview deployments. Apps created before these were added must be updated on GitHub (ADR 0017).
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
  deployments: 'write',
  pull_requests: 'read',
} as const;
export const GITHUB_APP_EVENTS = ['release', 'push', 'pull_request'] as const;
/** How long the capabilities of a connection are cached by the API. */
export const GITHUB_CAPABILITIES_TTL_MS = 5 * 60 * 1000;
/** Release polling interval for PAT connections with autoDeployReleases. */
export const GITHUB_RELEASE_POLL_INTERVAL_MS = 5 * 60 * 1000;

export const GitHubLogin = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Must be a GitHub user or organization name')
  .openapi({ example: 'jenspenneman' });

export const GitHubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'Must be a GitHub repository name')
  .refine((name) => name !== '.' && name !== '..', 'Must be a GitHub repository name')
  .openapi({ example: 'trail' });

export const RepositoryRef = z
  .object({ owner: GitHubLogin, name: GitHubRepoName })
  .openapi('RepositoryRef');
export type RepositoryRef = z.infer<typeof RepositoryRef>;

export const GitHubAccountType = z.enum(['User', 'Organization']);

export const GitHubConnection = z
  .object({
    id: GitHubConnectionId,
    kind: GitHubConnectionKind,
    name: DisplayName,
    account: z
      .object({ login: GitHubLogin, type: GitHubAccountType })
      .nullable()
      .openapi({ description: 'Account the installation/token belongs to, once known' }),
    app: z
      .object({
        appId: z.number().int().positive(),
        slug: z.string(),
        htmlUrl: z.url(),
        installUrl: z.url(),
        installationId: z.number().int().positive().nullable(),
      })
      .nullable()
      .openapi({ description: 'Present for kind=app. Secrets are never returned.' }),
    webhooksEnabled: z.boolean(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('GitHubConnection');
export type GitHubConnection = z.infer<typeof GitHubConnection>;

export const GitHubConnectionList = list(GitHubConnection).openapi('GitHubConnectionList');
export type GitHubConnectionList = z.infer<typeof GitHubConnectionList>;

export const CreatePatConnectionInput = z
  .strictObject({
    name: DisplayName,
    token: z
      .string()
      .regex(
        /^(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{36,255})$/,
        'Must be a GitHub token',
      )
      .openapi({ description: 'Fine-grained PAT with Contents: read and Metadata: read' }),
  })
  .openapi('CreatePatConnectionInput');
export type CreatePatConnectionInput = z.infer<typeof CreatePatConnectionInput>;

// --- GitHub App manifest flow ----------------------------------------------------------------

/** https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest */
export const GitHubAppManifest = z
  .object({
    name: z.string().min(1).max(34),
    url: z.url(),
    hook_attributes: z.object({ url: z.url(), active: z.boolean() }),
    redirect_url: z.url(),
    callback_urls: z.array(z.url()),
    setup_url: z.url(),
    description: z.string(),
    public: z.boolean(),
    default_permissions: z.record(z.string(), z.enum(['read', 'write'])),
    default_events: z.array(z.string()),
    setup_on_update: z.boolean(),
    request_oauth_on_install: z.boolean(),
  })
  .openapi('GitHubAppManifest');
export type GitHubAppManifest = z.infer<typeof GitHubAppManifest>;

export const StartAppManifestInput = z
  .strictObject({
    name: z.string().trim().min(1).max(34).optional().openapi({ description: 'GitHub App name' }),
    organization: GitHubLogin.optional().openapi({
      description: 'Create the app under this organization',
    }),
  })
  .openapi('StartAppManifestInput');
export type StartAppManifestInput = z.infer<typeof StartAppManifestInput>;

/** The UI posts `manifest` (as a form field) to `postUrl`; GitHub redirects back with `code` + `state`. */
export const AppManifestStart = z
  .object({ postUrl: z.url(), state: z.string(), manifest: GitHubAppManifest })
  .openapi('AppManifestStart');
export type AppManifestStart = z.infer<typeof AppManifestStart>;

export const CompleteAppManifestInput = z
  .strictObject({ code: z.string().min(1).max(256), state: z.string().min(1).max(256) })
  .openapi('CompleteAppManifestInput');
export type CompleteAppManifestInput = z.infer<typeof CompleteAppManifestInput>;

/** Query of GitHub's post-installation redirect (setup_url). */
export const InstallationCallbackQuery = z.object({
  installation_id: z.coerce.number().int().positive(),
  setup_action: z.enum(['install', 'update', 'request']).optional(),
  state: z.string().max(256).optional(),
});
export type InstallationCallbackQuery = z.infer<typeof InstallationCallbackQuery>;

// --- Repositories and releases ---------------------------------------------------------------

export const GitHubRepo = z
  .object({
    id: z.number().int().positive(),
    owner: GitHubLogin,
    name: GitHubRepoName,
    fullName: z.string(),
    private: z.boolean(),
    defaultBranch: z.string(),
    description: z.string().nullable(),
    htmlUrl: z.url(),
    pushedAt: Timestamp.nullable(),
  })
  .openapi('GitHubRepo');
export type GitHubRepo = z.infer<typeof GitHubRepo>;

export const GitHubRepoPage = page(GitHubRepo).openapi('GitHubRepoPage');
export type GitHubRepoPage = z.infer<typeof GitHubRepoPage>;

export const GitHubRepoListQuery = PaginationQuery.extend({
  connectionId: GitHubConnectionId,
  query: z.string().trim().max(100).optional().openapi({ description: 'Filter by name' }),
});
export type GitHubRepoListQuery = z.infer<typeof GitHubRepoListQuery>;

export const GitHubRelease = z
  .object({
    id: z.number().int().positive(),
    tagName: z.string(),
    name: z.string().nullable(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    publishedAt: Timestamp.nullable(),
    htmlUrl: z.url(),
    body: z.string().nullable().openapi({ description: 'Release notes (Markdown)' }),
    targetCommitish: z.string(),
  })
  .openapi('GitHubRelease');
export type GitHubRelease = z.infer<typeof GitHubRelease>;

export const GitHubReleasePage = page(GitHubRelease).openapi('GitHubReleasePage');
export type GitHubReleasePage = z.infer<typeof GitHubReleasePage>;

export const GitHubReleaseListQuery = PaginationQuery.extend({ connectionId: GitHubConnectionId });
export type GitHubReleaseListQuery = z.infer<typeof GitHubReleaseListQuery>;

// --- Ref resolution --------------------------------------------------------------------------

export const GIT_REF_KINDS = ['tag', 'branch', 'commit'] as const;

export const ResolvedGitRef = z
  .object({
    ref: z.string().openapi({ description: 'The ref as requested' }),
    sha: CommitSha,
    kind: z.enum(GIT_REF_KINDS).openapi({ description: 'How the ref was resolved' }),
  })
  .openapi('ResolvedGitRef');
export type ResolvedGitRef = z.infer<typeof ResolvedGitRef>;

export const GitHubRefQuery = z.object({ connectionId: GitHubConnectionId });
export type GitHubRefQuery = z.infer<typeof GitHubRefQuery>;

// --- Capabilities ----------------------------------------------------------------------------

export const GitHubCapabilitiesQuery = z.object({
  refresh: z
    .stringbool()
    .default(false)
    .openapi({ description: 'Bypass the 5-minute cache (after granting permissions on GitHub)' }),
});
export type GitHubCapabilitiesQuery = z.infer<typeof GitHubCapabilitiesQuery>;

/**
 * What a connection may do on GitHub beyond reading code. GitHub Apps: read with the app JWT
 * (`GET /app` and the installation). Tokens: probed with cheap read calls on a repository; write
 * access to deployments is inferred from the last mirror attempt.
 */
export const GitHubConnectionCapabilities = z
  .object({
    connectionId: GitHubConnectionId,
    kind: GitHubConnectionKind,
    deployments: z
      .boolean()
      .openapi({ description: 'Launchway can create deployments and statuses on GitHub' }),
    pullRequests: z.boolean().openapi({ description: 'Launchway can read pull requests' }),
    events: z
      .array(z.string())
      .openapi({ description: 'Webhook events delivered to Launchway (empty for tokens)' }),
    missing: z.array(z.string()).openapi({
      description:
        'Permissions (`deployments: write`) and events (`event: pull_request`) still to grant',
      example: ['deployments: write', 'event: pull_request'],
    }),
    pendingApproval: z.boolean().openapi({
      description:
        'The GitHub App requests everything, but the installation has not approved the new permissions yet',
    }),
    settingsUrl: z.url().openapi({
      description:
        "Where to grant the permissions: the app's permission settings, or the token page",
    }),
    installationSettingsUrl: z.url().nullable().openapi({
      description: 'Where the installation owner approves updated permissions (GitHub Apps)',
    }),
    probedRepository: z.string().nullable().openapi({
      description: 'Repository the token was probed on (tokens only)',
    }),
    lastDeniedAt: Timestamp.nullable().openapi({
      description: 'Last time GitHub refused a deployment mirror request of this connection',
    }),
    checkedAt: Timestamp,
  })
  .openapi('GitHubConnectionCapabilities');
export type GitHubConnectionCapabilities = z.infer<typeof GitHubConnectionCapabilities>;
