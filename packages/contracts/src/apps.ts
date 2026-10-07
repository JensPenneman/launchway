import {
  DisplayName,
  GitRef,
  RelativePath,
  RoutableServiceName,
  ServiceName,
  Timestamp,
} from './common.js';
import { ServiceStatus } from './deployments.js';
import { RepositoryRef } from './github.js';
import { AppId, DeploymentId, EnvVarId, GitHubConnectionId, NodeId } from './ids.js';
import { list, PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

// --- Runtime naming conventions (spec section 3) ---------------------------------------------

export const DEFAULT_PROXY_NETWORK = 'launchway-proxy';
export const LAUNCHWAY_LABELS = {
  app: 'launchway.app',
  deployment: 'launchway.deployment',
  service: 'launchway.service',
} as const;

/**
 * Slug a preview of an app runs under (`<slug>-pr-<number>`). The agent derives the Compose project
 * name and the network aliases from the slug it receives, so a preview is an ordinary project.
 */
export function previewSlug(slug: string, prNumber: number): string {
  return `${slug}-pr-${prNumber}`;
}

/** Compose project name of an app (`launchway-<slug>`), or of one of its previews. */
export function composeProjectName(slug: string, preview?: number): string {
  return `launchway-${preview === undefined ? slug : previewSlug(slug, preview)}`;
}

/**
 * Network alias of a routed service on the proxy network (`<app-slug>-<service>`; for a preview
 * `<app-slug>-pr-<number>-<service>`).
 */
export function serviceAlias(slug: string, service: string, preview?: number): string {
  const alias = `${preview === undefined ? slug : previewSlug(slug, preview)}-${service}`;
  if (alias.length > 63) throw new RangeError(`Service alias "${alias}" exceeds 63 characters`);
  return alias;
}

// --- App ---------------------------------------------------------------------------------------

/** Slugs that would collide with platform containers on the proxy network. */
export const RESERVED_APP_SLUGS: readonly string[] = ['launchway', 'caddy', 'db', 'agent'];

export const AppSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'Use 1-40 lowercase letters, digits and dashes')
  .refine((slug) => !RESERVED_APP_SLUGS.includes(slug), 'This slug is reserved')
  .openapi({ example: 'trail' });
export type AppSlug = z.infer<typeof AppSlug>;

export const DEFAULT_COMPOSE_FILES = ['compose.yaml'] as const;
export const ComposeFiles = z
  .array(RelativePath)
  .min(1)
  .max(10)
  .openapi({ description: 'Merged in order by Compose', example: ['compose.yaml'] });

/** Normalized build source of an app. */
export const AppSource = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('compose'), composeFiles: ComposeFiles }),
    z.object({ kind: z.literal('dockerfile'), dockerfile: RelativePath, context: RelativePath }),
  ])
  .openapi('AppSource');
export type AppSource = z.infer<typeof AppSource>;

interface SourceFields {
  composeFiles?: readonly string[] | null | undefined;
  dockerfile?: string | null | undefined;
  context?: string | null | undefined;
}

/**
 * Resolves the stored/submitted source fields into a normalized source. `composeFiles` XOR
 * `dockerfile` (+ optional `context`, default `.`); neither means `["compose.yaml"]`.
 */
export function resolveAppSource(fields: SourceFields): AppSource {
  if (fields.dockerfile) {
    return { kind: 'dockerfile', dockerfile: fields.dockerfile, context: fields.context ?? '.' };
  }
  return { kind: 'compose', composeFiles: [...(fields.composeFiles ?? DEFAULT_COMPOSE_FILES)] };
}

function checkSourceXor(value: SourceFields, ctx: z.RefinementCtx): void {
  const hasCompose = value.composeFiles !== undefined && value.composeFiles !== null;
  const hasDockerfile = value.dockerfile !== undefined && value.dockerfile !== null;
  if (hasCompose && hasDockerfile) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide either composeFiles or dockerfile (+ context), not both',
      path: ['dockerfile'],
    });
  }
  if (!hasDockerfile && value.context !== undefined && value.context !== null) {
    ctx.addIssue({ code: 'custom', message: 'context requires dockerfile', path: ['context'] });
  }
}

/** The admin decision that lets an app's Compose project use host bind mounts and foreign volumes. */
export const TrustedMounts = z.boolean().openapi({
  description:
    "Allows bind mounts below the node's allowedBindRoots, external volumes and custom volume names. Setting it requires the admin role.",
});
/** Per-app switch of the GitHub deployment mirror (ADR 0017). */
export const GitHubDeploymentsFlag = z.boolean().openapi({
  description:
    "Mirror this app's deployments to GitHub's Deployments API (needs deployments: write on the connection)",
});
/**
 * Services attached to the proxy network without a public route (e.g. a forward-auth gate the
 * edge calls by its alias). Admin only to change.
 */
export const ProxyServices = z
  .array(RoutableServiceName)
  .max(20)
  .refine((names) => new Set(names).size === names.length, 'Service names must be unique')
  .openapi({
    description:
      'Services attached to the proxy network as <slug>-<service> without a route (admin only to change)',
    example: ['oauth2-proxy'],
  });

/** Branch whose pushes deploy the app (`push` webhook); null = no branch auto-deploy. */
export const AutoDeployBranch = GitRef.openapi({
  description:
    'Branch whose pushes create an automatic deployment of the pushed commit (GitHub App connections; the app must subscribe to push events)',
  example: 'main',
});
// --- Environment variables ---------------------------------------------------------------------

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Prefix of the variables Launchway sets on every deployment; user keys may not use it. */
export const PLATFORM_ENV_PREFIX = 'LAUNCHWAY_';

/** Variables Launchway adds to the environment of every deployment (spec section 4). */
export const PLATFORM_ENV_KEYS = [
  'LAUNCHWAY_APP',
  'LAUNCHWAY_APP_ID',
  'LAUNCHWAY_DEPLOYMENT_ID',
  'LAUNCHWAY_REF',
  'LAUNCHWAY_COMMIT_SHA',
  'LAUNCHWAY_COMMIT_SHA_SHORT',
  'LAUNCHWAY_NODE',
  'LAUNCHWAY_ENVIRONMENT',
  'LAUNCHWAY_PREVIEW_NUMBER',
  'LAUNCHWAY_PUBLIC_URL',
] as const;
export type PlatformEnvKey = (typeof PLATFORM_ENV_KEYS)[number];

/** Syntax of an environment variable name, platform variables included. */
export const EnvKeyName = z
  .string()
  .min(1)
  .max(255)
  .regex(ENV_KEY_PATTERN, 'Must match [A-Za-z_][A-Za-z0-9_]*');

/** Name of a user-defined variable: `LAUNCHWAY_*` is reserved for the platform variables. */
export const EnvKey = EnvKeyName.refine(
  (key) => !key.startsWith(PLATFORM_ENV_PREFIX),
  `Keys starting with ${PLATFORM_ENV_PREFIX} are reserved for the variables Launchway sets (${PLATFORM_ENV_KEYS.join(', ')})`,
).openapi({ example: 'DATABASE_URL' });

export const EnvValue = z
  .string()
  .max(65_536)
  .regex(/^[^\0]*$/, 'Must not contain NUL characters');

// --- Preview settings (spec section 4, previews) ----------------------------------------------

/** Placeholders of a preview host template. */
export const PREVIEW_HOST_PLACEHOLDERS = ['slug', 'number', 'base'] as const;
export const DEFAULT_PREVIEW_HOST_TEMPLATE = '{slug}-pr-{number}.{base}';

/** Placeholders an environment override of a preview may use (`{{name}}`). */
export const PREVIEW_ENV_PLACEHOLDERS = [
  'previewUrl',
  'previewHost',
  'prNumber',
  'branch',
  'sha',
] as const;
export type PreviewEnvPlaceholder = (typeof PREVIEW_ENV_PLACEHOLDERS)[number];

export const PreviewHostTemplate = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(200)
  .regex(
    /^(?:[a-z0-9-]|\{(?:slug|number|base)\})+(?:\.(?:[a-z0-9-]|\{(?:slug|number|base)\})+)*$/,
    'Use lower-case letters, digits, dashes, dots and the placeholders {slug}, {number} and {base}',
  )
  .refine((value) => value.includes('{number}'), 'Must contain {number}')
  .refine((value) => value.endsWith('.{base}'), 'Must end with .{base}')
  .openapi({ example: DEFAULT_PREVIEW_HOST_TEMPLATE });

const ENV_PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/** Names of the `{{placeholders}}` in an override value that previews do not know. */
export function unknownEnvPlaceholders(value: string): string[] {
  const known: readonly string[] = PREVIEW_ENV_PLACEHOLDERS;
  return [...value.matchAll(ENV_PLACEHOLDER)]
    .map((match) => match[1] ?? '')
    .filter((name) => !known.includes(name));
}

/** Environment overrides of previews: app variables are replaced or added, placeholders filled. */
export const PreviewEnvOverrides = z
  .record(EnvKey, EnvValue)
  .refine((value) => Object.keys(value).length <= 100, 'At most 100 overrides')
  .superRefine((value, ctx) => {
    for (const [key, text] of Object.entries(value)) {
      const unknown = unknownEnvPlaceholders(text);
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(', ')}; use ${PREVIEW_ENV_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}`,
        });
      }
    }
  })
  .openapi({
    description:
      'Variables replaced or added in previews. Values may use {{previewUrl}}, {{previewHost}}, {{prNumber}}, {{branch}} and {{sha}}. Stored like plain variables: do not put secrets here.',
    example: { BASE_URL: '{{previewUrl}}', DATABASE_NAME: 'trail_pr_{{prNumber}}' },
  });

/** A label pull requests need for a preview; matched case-insensitively, like GitHub does. */
export const PreviewLabel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]+$/u, 'Must not contain control characters')
  .openapi({ example: 'preview' });

/** Per-app preview settings. */
export const AppPreviewSettings = z
  .object({
    enabled: z.boolean().openapi({
      description: 'Pull requests from branches of the repository get a preview environment',
    }),
    skipBots: z.boolean().openapi({
      description:
        'Pull requests opened by bots (such as Dependabot) get no preview from the webhook; the API can still open one',
    }),
    requireLabel: PreviewLabel.nullable().openapi({
      description:
        'Only pull requests with this label get a preview from the webhook, and removing the label closes it; null previews every pull request',
    }),
    hostTemplate: PreviewHostTemplate,
    envOverrides: PreviewEnvOverrides,
    composeFiles: ComposeFiles.nullable().openapi({
      description:
        "Compose files of previews (e.g. without the production volumes); null uses the app's own source",
    }),
  })
  .openapi('AppPreviewSettings');
export type AppPreviewSettings = z.infer<typeof AppPreviewSettings>;

export const DEFAULT_APP_PREVIEW_SETTINGS: AppPreviewSettings = {
  enabled: false,
  skipBots: true,
  requireLabel: null,
  hostTemplate: DEFAULT_PREVIEW_HOST_TEMPLATE,
  envOverrides: {},
  composeFiles: null,
};

/** Partial update of the preview settings; omitted fields keep their value. */
export const UpdateAppPreviewSettings = z
  .strictObject({
    enabled: z.boolean().optional(),
    skipBots: z.boolean().optional(),
    requireLabel: PreviewLabel.nullable().optional(),
    hostTemplate: PreviewHostTemplate.optional(),
    envOverrides: PreviewEnvOverrides.optional(),
    composeFiles: ComposeFiles.nullable().optional(),
  })
  .openapi('UpdateAppPreviewSettings');
export type UpdateAppPreviewSettings = z.infer<typeof UpdateAppPreviewSettings>;

export const App = z
  .object({
    id: AppId,
    slug: AppSlug,
    name: DisplayName,
    description: z.string().max(500).nullable(),
    connectionId: GitHubConnectionId,
    repository: RepositoryRef,
    composeFiles: ComposeFiles.nullable().openapi({
      description: 'Set when the app uses Compose files',
    }),
    dockerfile: RelativePath.nullable().openapi({
      description: 'Set when the app uses a Dockerfile',
    }),
    context: RelativePath.nullable().openapi({ description: 'Build context for dockerfile' }),
    nodeId: NodeId,
    autoDeployReleases: z.boolean(),
    autoDeployPrereleases: z.boolean().openapi({
      description: 'With autoDeployReleases: also deploy releases marked as prerelease',
    }),
    autoDeployBranch: AutoDeployBranch.nullable(),
    githubDeployments: GitHubDeploymentsFlag,
    trustedMounts: TrustedMounts,
    proxyServices: ProxyServices,
    previews: AppPreviewSettings,
    activeDeploymentId: DeploymentId.nullable().openapi({
      description: 'The running production deployment',
    }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('App');
export type App = z.infer<typeof App>;

export const AppPage = page(App).openapi('AppPage');
export type AppPage = z.infer<typeof AppPage>;

export const AppListQuery = PaginationQuery.extend({ nodeId: NodeId.optional() });
export type AppListQuery = z.infer<typeof AppListQuery>;

export const CreateAppInput = z
  .strictObject({
    name: DisplayName,
    slug: AppSlug.optional().openapi({
      description: 'Derived from the name when omitted; immutable',
    }),
    description: z.string().trim().max(500).optional(),
    connectionId: GitHubConnectionId,
    repository: RepositoryRef,
    composeFiles: ComposeFiles.optional(),
    dockerfile: RelativePath.optional(),
    context: RelativePath.optional(),
    nodeId: NodeId,
    autoDeployReleases: z.boolean().default(false),
    autoDeployPrereleases: z.boolean().default(false),
    autoDeployBranch: AutoDeployBranch.nullable().default(null),
    githubDeployments: GitHubDeploymentsFlag.default(true),
    trustedMounts: TrustedMounts.default(false),
  })
  .superRefine(checkSourceXor)
  .openapi('CreateAppInput', {
    description: 'composeFiles XOR dockerfile (+ context, default "."); neither = ["compose.yaml"]',
  });
export type CreateAppInput = z.infer<typeof CreateAppInput>;

/** Setting composeFiles switches the app to Compose; setting dockerfile switches it to a Dockerfile. */
export const UpdateAppInput = z
  .strictObject({
    name: DisplayName.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    connectionId: GitHubConnectionId.optional(),
    composeFiles: ComposeFiles.optional(),
    dockerfile: RelativePath.optional(),
    context: RelativePath.optional(),
    nodeId: NodeId.optional(),
    autoDeployReleases: z.boolean().optional(),
    autoDeployPrereleases: z.boolean().optional(),
    autoDeployBranch: AutoDeployBranch.nullable().optional(),
    githubDeployments: GitHubDeploymentsFlag.optional(),
    trustedMounts: TrustedMounts.optional(),
    proxyServices: ProxyServices.optional().openapi({
      description: 'Requires the admin role; takes effect with the next deployment',
    }),
    previews: UpdateAppPreviewSettings.optional(),
  })
  .superRefine((value, ctx) => {
    checkSourceXor(value, ctx);
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one field', path: [] });
    }
  })
  .openapi('UpdateAppInput');
export type UpdateAppInput = z.infer<typeof UpdateAppInput>;

// --- Environment variables (continued) -------------------------------------------------------

/** Values are encrypted at rest; `secret` ones are never returned (value is null). */
export const EnvVar = z
  .object({
    id: EnvVarId,
    key: EnvKeyName.openapi({ example: 'DATABASE_URL' }),
    secret: z.boolean(),
    value: z.string().nullable().openapi({ description: 'null when secret' }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('EnvVar');
export type EnvVar = z.infer<typeof EnvVar>;

export const EnvVarList = list(EnvVar).openapi('EnvVarList');
export type EnvVarList = z.infer<typeof EnvVarList>;

/** Masks the value of secret variables for API responses. */
export function maskEnvVar<T extends { secret: boolean; value: string }>(
  variable: T,
): Omit<T, 'value'> & { value: string | null } {
  return { ...variable, value: variable.secret ? null : variable.value };
}

export const CreateEnvVarInput = z
  .strictObject({ key: EnvKey, value: EnvValue, secret: z.boolean().default(false) })
  .openapi('CreateEnvVarInput');
export type CreateEnvVarInput = z.infer<typeof CreateEnvVarInput>;

export const UpdateEnvVarInput = z
  .strictObject({ value: EnvValue.optional(), secret: z.boolean().optional() })
  .refine((v) => v.value !== undefined || v.secret !== undefined, 'Provide at least one field')
  .refine((v) => !(v.secret === false && v.value === undefined), {
    message: 'Provide a new value when turning a secret into a plain variable',
    path: ['value'],
  })
  .openapi('UpdateEnvVarInput');
export type UpdateEnvVarInput = z.infer<typeof UpdateEnvVarInput>;

/** Bulk upsert (e.g. pasting a .env file). Omitting `value` keeps the stored value of that key. */
export const SetEnvVarsInput = z
  .strictObject({
    variables: z
      .array(
        z.strictObject({
          key: EnvKey,
          value: EnvValue.optional(),
          secret: z.boolean().default(false),
        }),
      )
      .max(500),
  })
  .refine((v) => new Set(v.variables.map((e) => e.key)).size === v.variables.length, {
    message: 'Keys must be unique',
    path: ['variables'],
  })
  .openapi('SetEnvVarsInput');
export type SetEnvVarsInput = z.infer<typeof SetEnvVarsInput>;

// --- App runtime -------------------------------------------------------------------------------

export const AppLogsQuery = z.object({
  service: ServiceName.optional(),
  follow: z.stringbool().default(false),
  tail: z.coerce.number().int().min(0).max(10_000).default(200),
});
export type AppLogsQuery = z.infer<typeof AppLogsQuery>;

/** Query of `DELETE /apps/{id}`. */
export const DeleteAppQuery = z.object({
  force: z.stringbool().default(false).openapi({
    description: 'Delete even when the node is offline (its containers are left behind)',
  }),
  removeVolumes: z.stringbool().default(false).openapi({
    description: 'Also remove the named volumes of the app ("delete data")',
  }),
});
export type DeleteAppQuery = z.infer<typeof DeleteAppQuery>;

/** Runtime state of an app's containers (`GET /apps/{id}/status`, `POST /apps/{id}/stop`). */
export const AppRuntimeStatus = z
  .object({
    appId: AppId,
    nodeId: NodeId,
    nodeOnline: z.boolean(),
    source: z.enum(['agent', 'last-deployment']).openapi({
      description:
        'agent: live from the node; last-deployment: the node is offline, last reported state',
    }),
    activeDeploymentId: DeploymentId.nullable(),
    services: z.array(ServiceStatus),
  })
  .openapi('AppRuntimeStatus');
export type AppRuntimeStatus = z.infer<typeof AppRuntimeStatus>;
