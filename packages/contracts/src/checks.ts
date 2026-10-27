import { CheckName, ComposeFiles, MAX_CHECK_ITEMS } from './apps.js';
import { CommitSha, GitRef, ServiceName, Timestamp } from './common.js';
import { AppId, CheckRunId, NodeId, type TypeId, UserId } from './ids.js';
import { list, PaginationQuery, page } from './pagination.js';
import { PrNumber } from './previews.js';
import { z } from './zod.js';

// --- Runs (ADR 0020) ---------------------------------------------------------------------------

/**
 * queued: waiting for its node (one check runs per node at a time); running: sent to the node;
 * succeeded: the command exited 0; failed: it exited non-zero or timed out; errored: the run could
 * not produce a verdict (policy, build, Docker, node offline, superseded); cancelled: stopped on
 * request.
 */
export const CHECK_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'errored',
  'cancelled',
] as const;
export const CheckRunStatus = z.enum(CHECK_RUN_STATUSES).openapi('CheckRunStatus');
export type CheckRunStatus = z.infer<typeof CheckRunStatus>;

/** Statuses of a run that has not finished. */
export const ACTIVE_CHECK_RUN_STATUSES = [
  'queued',
  'running',
] as const satisfies readonly CheckRunStatus[];

export function isActiveCheckRunStatus(status: CheckRunStatus): boolean {
  return (ACTIVE_CHECK_RUN_STATUSES as readonly CheckRunStatus[]).includes(status);
}

export const CHECK_RUN_TRIGGERS = ['push', 'pull_request', 'manual'] as const;
export const CheckRunTrigger = z.enum(CHECK_RUN_TRIGGERS).openapi('CheckRunTrigger', {
  description:
    'push: a push to a branch of the repository; pull_request: a pull request from a branch of the repository; manual: an API request (or a re-run)',
});
export type CheckRunTrigger = z.infer<typeof CheckRunTrigger>;

/**
 * Why a run ended: `exit` (the command exited, see exitCode), `timeout` (it ran longer than
 * timeoutMinutes), `policy` (the Compose policy refused the project), `build` (fetching the commit,
 * reading the Compose files, building or pulling failed), `infrastructure` (Docker failed: the
 * source volume, a dependency that does not start, ...), `interrupted` (the agent shut down),
 * `cancelled`, `superseded` (a newer commit of the branch arrived while it waited), `offline` (the
 * node was offline too long or went away), `lost` (the node no longer reports it), `unsupported`
 * (the node's agent does not run checks) and `dispatch` (the control plane could not prepare it).
 */
export const CHECK_RUN_REASONS = [
  'exit',
  'timeout',
  'policy',
  'build',
  'infrastructure',
  'interrupted',
  'cancelled',
  'superseded',
  'offline',
  'lost',
  'unsupported',
  'dispatch',
] as const;
export const CheckRunReason = z.enum(CHECK_RUN_REASONS).openapi('CheckRunReason');
export type CheckRunReason = z.infer<typeof CheckRunReason>;

/** The reasons an agent reports in `check.result`. */
export const CHECK_RESULT_REASONS = [
  'exit',
  'timeout',
  'policy',
  'build',
  'infrastructure',
  'interrupted',
  'cancelled',
] as const satisfies readonly CheckRunReason[];
export const CheckResultReason = z.enum(CHECK_RESULT_REASONS);
export type CheckResultReason = z.infer<typeof CheckResultReason>;

/** States of a GitHub commit status. */
export const GITHUB_COMMIT_STATUS_STATES = ['pending', 'success', 'failure', 'error'] as const;
export const GitHubCommitStatusState = z
  .enum(GITHUB_COMMIT_STATUS_STATES)
  .openapi('GitHubCommitStatusState');
export type GitHubCommitStatusState = z.infer<typeof GitHubCommitStatusState>;

/** GitHub status context of a check (`launchway/<name>`), the name branch protection requires. */
export function checkStatusContext(name: string): string {
  return `launchway/${name}`;
}

/**
 * The commit status GitHub shows for a run: pending while queued or running, success for exit 0,
 * failure for a non-zero exit or a timeout, error for everything that is no verdict on the code.
 */
export function githubStateOfCheck(status: CheckRunStatus): GitHubCommitStatusState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'pending';
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'failure';
    case 'errored':
    case 'cancelled':
      return 'error';
  }
}

export const CheckRun = z
  .object({
    id: CheckRunId,
    appId: AppId,
    nodeId: NodeId,
    name: CheckName,
    command: z
      .string()
      .openapi({ description: 'The command as configured when the run was queued' }),
    service: ServiceName,
    composeFiles: ComposeFiles,
    timeoutMinutes: z.number().int().min(1),
    commitSha: CommitSha,
    ref: GitRef.nullable().openapi({
      description: 'Branch of the push or the pull request, or the ref of a manual run',
    }),
    prNumber: PrNumber.nullable(),
    trigger: CheckRunTrigger,
    status: CheckRunStatus,
    reason: CheckRunReason.nullable().openapi({ description: 'Set once the run has finished' }),
    exitCode: z.number().int().nullable().openapi({ description: "The command's exit code" }),
    statusMessage: z.string().nullable(),
    githubState: GitHubCommitStatusState.nullable().openapi({
      description:
        'State last posted to GitHub as the commit status launchway/<name>; null when none was posted',
    }),
    triggeredBy: UserId.nullable(),
    createdAt: Timestamp,
    startedAt: Timestamp.nullable().openapi({ description: 'When the run was sent to its node' }),
    finishedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
  })
  .openapi('CheckRun');
export type CheckRun = z.infer<typeof CheckRun>;

export const CheckRunPage = page(CheckRun).openapi('CheckRunPage');
export type CheckRunPage = z.infer<typeof CheckRunPage>;

export const CheckRunList = list(CheckRun).openapi('CheckRunList');
export type CheckRunList = z.infer<typeof CheckRunList>;

export const CheckRunListQuery = PaginationQuery.extend({
  status: CheckRunStatus.optional(),
  name: CheckName.optional(),
  commitSha: CommitSha.optional(),
});
export type CheckRunListQuery = z.infer<typeof CheckRunListQuery>;

/** `POST /apps/{id}/checks`: runs the app's checks for a ref by hand. */
export const CreateCheckRunsInput = z
  .strictObject({
    ref: GitRef.openapi({
      description: 'Branch, tag or commit (full or abbreviated SHA); resolved to a commit',
      example: 'main',
    }),
    names: z
      .array(CheckName)
      .min(1)
      .max(MAX_CHECK_ITEMS)
      .refine((names) => new Set(names).size === names.length, 'Names must be unique')
      .optional()
      .openapi({ description: 'Only these checks; every configured check when omitted' }),
  })
  .openapi('CreateCheckRunsInput');
export type CreateCheckRunsInput = z.infer<typeof CreateCheckRunsInput>;

export const CheckLogsQuery = z.object({
  follow: z.stringbool().default(false),
  after: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: 'Only lines with seq > after' }),
});
export type CheckLogsQuery = z.infer<typeof CheckLogsQuery>;

// --- Limits and retention -----------------------------------------------------------------------

/** Defaults of the platform settings that cap every service of a check. */
export const DEFAULT_CHECK_MEMORY_MB = 4096;
export const DEFAULT_CHECK_CPUS = 2;
export const DEFAULT_CHECK_PIDS_LIMIT = 4096;

export const CheckMemoryMb = z.number().int().min(256).max(262_144).openapi({
  description: 'Memory of every service of a check, in MiB (swap is off)',
  example: DEFAULT_CHECK_MEMORY_MB,
});
export const CheckCpus = z.number().min(0.25).max(128).multipleOf(0.25).openapi({
  description: 'CPUs of every service of a check',
  example: DEFAULT_CHECK_CPUS,
});
export const CheckPidsLimit = z.number().int().min(64).max(1_048_576).openapi({
  description: 'Processes and threads of every service of a check',
  example: DEFAULT_CHECK_PIDS_LIMIT,
});

/** Log lines the agent sends per run; it then sends one "truncated" line and drops the rest. */
export const CHECK_LOG_LINE_LIMIT = 20_000;
/** Check log lines are deleted this long after they were written; the runs are kept. */
export const CHECK_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A queued run whose node has been offline this long is errored. */
export const QUEUED_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

// --- Naming on the node ---------------------------------------------------------------------------

/** Label on every container, volume and network of a check (value: the run id). */
export const CHECK_LABEL = 'launchway.check';
/** Compose projects of checks start with this; app slugs contain no `_`, so it cannot collide. */
export const CHECK_PROJECT_PREFIX = 'launchway-check_';

/** Compose project of one run: `launchway-check_<slug>_<run id suffix>`. */
export function checkProjectName(slug: string, runId: TypeId<'chk'>): string {
  return `${CHECK_PROJECT_PREFIX}${slug}_${runId.slice('chk_'.length)}`;
}

/** Image tag of a service a check builds: one per app and service, so runs do not pile up. */
export function checkImageName(slug: string, service: string): string {
  return `launchway-check/${slug}-${service}`;
}

/** The only variables a check gets from Launchway (no app variables, no secrets). */
export const CHECK_ENV_KEYS = [
  'CI',
  'COMPOSE_PROJECT_NAME',
  'LAUNCHWAY_APP',
  'LAUNCHWAY_CHECK',
  'LAUNCHWAY_CHECK_RUN_ID',
  'LAUNCHWAY_COMMIT_SHA',
  'LAUNCHWAY_REF',
] as const;
