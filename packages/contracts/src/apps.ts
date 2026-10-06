import { DisplayName, RelativePath, ServiceName, Timestamp } from './common.js';
import { ServiceStatus } from './deployments.js';
import { RepositoryRef } from './github.js';
import { AppId, DeploymentId, EnvVarId, GitHubConnectionId, NodeId } from './ids.js';
import { list, PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

// --- Runtime naming conventions (spec section 3) ---------------------------------------------

export const DEFAULT_PROXY_NETWORK = 'slipway-proxy';
export const SLIPWAY_LABELS = {
  app: 'slipway.app',
  deployment: 'slipway.deployment',
  service: 'slipway.service',
} as const;

/** Compose project name of an app. */
export function composeProjectName(slug: string): string {
  return `slipway-${slug}`;
}

/** Network alias of a routed service on the proxy network (`<app-slug>-<service>`). */
export function serviceAlias(slug: string, service: string): string {
  const alias = `${slug}-${service}`;
  if (alias.length > 63) throw new RangeError(`Service alias "${alias}" exceeds 63 characters`);
  return alias;
}

// --- App ---------------------------------------------------------------------------------------

/** Slugs that would collide with platform containers on the proxy network. */
export const RESERVED_APP_SLUGS: readonly string[] = ['slipway', 'caddy', 'db', 'agent'];

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
    activeDeploymentId: DeploymentId.nullable(),
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
  })
  .superRefine((value, ctx) => {
    checkSourceXor(value, ctx);
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one field', path: [] });
    }
  })
  .openapi('UpdateAppInput');
export type UpdateAppInput = z.infer<typeof UpdateAppInput>;

// --- Environment variables ---------------------------------------------------------------------

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const EnvKey = z
  .string()
  .min(1)
  .max(255)
  .regex(ENV_KEY_PATTERN, 'Must match [A-Za-z_][A-Za-z0-9_]*')
  .openapi({ example: 'DATABASE_URL' });

export const EnvValue = z
  .string()
  .max(65_536)
  .regex(/^[^\0]*$/, 'Must not contain NUL characters');

/** Values are encrypted at rest; `secret` ones are never returned (value is null). */
export const EnvVar = z
  .object({
    id: EnvVarId,
    key: EnvKey,
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
