import { type AppPreviewSettings, PREVIEW_ENV_PLACEHOLDERS, previewSlug } from './apps.js';
import { CommitSha, Hostname, Timestamp } from './common.js';
import { DeploymentStatus, EnvironmentName } from './deployments.js';
import { AppId, DeploymentId, DomainId, PreviewId, RouteId, type TypeId } from './ids.js';
import { PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

// --- Naming --------------------------------------------------------------------------------------

/**
 * App id the agent knows a preview by: the preview id's suffix under the `app` prefix. It keys the
 * agent's checkouts and per-app queue, so removing or pruning a preview never touches the
 * production checkouts. Both ids are random UUIDv7s, so it cannot collide with a real app.
 */
export function previewAgentAppId(previewId: TypeId<'prv'>): TypeId<'app'> {
  return `app_${previewId.slice('prv_'.length)}`;
}

/** Whether `<slug>-pr-<number>` still fits the 40 characters of an app slug (agent contract). */
export function previewSlugFits(slug: string, prNumber: number): boolean {
  return previewSlug(slug, prNumber).length <= 40;
}

// --- Host names and environment -------------------------------------------------------------------

/** Renders a preview host template; throws RangeError when the result is not a valid host name. */
export function renderPreviewHost(
  template: string,
  values: { readonly slug: string; readonly number: number; readonly base: string },
): string {
  const host = template
    .replaceAll('{slug}', values.slug)
    .replaceAll('{number}', String(values.number))
    .replaceAll('{base}', values.base)
    .toLowerCase();
  const parsed = Hostname.safeParse(host);
  if (!parsed.success) throw new RangeError(`"${host}" is not a valid host name`);
  return parsed.data;
}

export interface PreviewEnvValues {
  readonly previewUrl: string;
  readonly previewHost: string;
  readonly prNumber: number;
  readonly branch: string;
  readonly sha: string;
}

/** Fills the `{{placeholders}}` of the override values; unknown names stay as they are. */
export function renderPreviewEnvOverrides(
  overrides: AppPreviewSettings['envOverrides'],
  values: PreviewEnvValues,
): Record<string, string> {
  const known: readonly string[] = PREVIEW_ENV_PLACEHOLDERS;
  const rendered: Record<string, string> = {};
  for (const [key, text] of Object.entries(overrides)) {
    rendered[key] = text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, name: string) =>
      known.includes(name) ? String(values[name as keyof PreviewEnvValues]) : match,
    );
  }
  return rendered;
}

// --- Limits --------------------------------------------------------------------------------------

export const DEFAULT_PREVIEW_MAX_PER_APP = 10;
export const DEFAULT_PREVIEW_MAX_TOTAL = 20;
/** Closed previews are kept this long for their history, then purged with their deployments. */
export const PREVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// --- Preview -------------------------------------------------------------------------------------

/**
 * pending: waiting for its first deployment; deploying: a deployment is in progress; running: a
 * deployment runs; failed: nothing runs and the last deployment (or the setup) failed; closing:
 * being removed; closed: removed, kept for history.
 */
export const PREVIEW_STATUSES = [
  'pending',
  'deploying',
  'running',
  'failed',
  'closing',
  'closed',
] as const;
export const PreviewStatus = z.enum(PREVIEW_STATUSES).openapi('PreviewStatus');
export type PreviewStatus = z.infer<typeof PreviewStatus>;
/** Statuses that count against the preview limits. */
export const OPEN_PREVIEW_STATUSES = [
  'pending',
  'deploying',
  'running',
  'failed',
  'closing',
] as const satisfies readonly PreviewStatus[];

export const PrNumber = z.number().int().min(1).max(9_999_999).openapi({ example: 42 });

export const Preview = z
  .object({
    id: PreviewId,
    appId: AppId,
    prNumber: PrNumber,
    prTitle: z.string(),
    branch: z.string(),
    headSha: CommitSha,
    environmentName: EnvironmentName,
    hostname: Hostname,
    url: z.url().openapi({ example: 'https://trail-pr-42.preview.example.com' }),
    domainId: DomainId.nullable(),
    routeId: RouteId.nullable(),
    status: PreviewStatus,
    statusMessage: z.string().nullable().openapi({ description: 'Why the preview failed' }),
    activeDeploymentId: DeploymentId.nullable().openapi({
      description: 'The running deployment of the preview',
    }),
    lastDeployment: z
      .object({ id: DeploymentId, status: DeploymentStatus, commitSha: CommitSha })
      .nullable()
      .openapi({ description: 'The newest deployment of the preview' }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    closedAt: Timestamp.nullable(),
  })
  .openapi('Preview');
export type Preview = z.infer<typeof Preview>;

export const PreviewPage = page(Preview).openapi('PreviewPage');
export type PreviewPage = z.infer<typeof PreviewPage>;

export const PreviewListQuery = PaginationQuery.extend({
  status: PreviewStatus.optional(),
  open: z.stringbool().optional().openapi({
    description: 'true: only previews that are not closed; false: only closed ones',
  }),
});
export type PreviewListQuery = z.infer<typeof PreviewListQuery>;

export const CreatePreviewInput = z
  .strictObject({ prNumber: PrNumber })
  .openapi('CreatePreviewInput', {
    description: 'Opens (or updates) the preview of an open pull request at its current head',
  });
export type CreatePreviewInput = z.infer<typeof CreatePreviewInput>;
