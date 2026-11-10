import { Timestamp } from './common.js';
import { parseCron } from './cron.js';
import { AppId, AutomationRunId } from './ids.js';
import { list } from './pagination.js';
import { z } from './zod.js';

// --- Automation (ADR 0023): Dependabot auto-merge, later the release train --------------------

export const AUTOMATION_MODES = ['off', 'shadow', 'on'] as const;
export const AutomationMode = z.enum(AUTOMATION_MODES).openapi('AutomationMode', {
  description:
    'off: nothing happens; shadow: decisions are recorded and nothing is written to GitHub; on: the automation acts',
});
export type AutomationMode = z.infer<typeof AutomationMode>;

/** GitHub's user id of `dependabot[bot]`. */
export const DEPENDABOT_USER_ID = 49699333;

/** Paths a Dependabot pull request may change and still merge on its own (patterns: `*` is one segment). */
export const DEFAULT_AUTOMATION_ALLOWED_PATHS: readonly string[] = [
  'package.json',
  'apps/*/package.json',
  'packages/*/package.json',
  'package-lock.json',
  'Dockerfile',
  '.devcontainer/Dockerfile',
  'scripts/mapdata/Dockerfile',
  'compose.yaml',
  'deploy/compose.yaml',
  '.devcontainer/compose*.yaml',
  'tools/load/compose.load.yaml',
];

/** Image name prefixes whose updates are held for a person unless a minor or patch update. */
export const DEFAULT_AUTOMATION_HOLD_IMAGES: readonly string[] = [
  'postgres',
  'postgis',
  'timescaledb',
  'pgvector',
];

const RepositoryPathPattern = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._*@+-]+(?:\/[A-Za-z0-9._*@+-]+)*$/, 'Use a relative path without "." parts')
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), 'No "." or ".." segments');

const ImagePrefix = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use a lowercase image name');

const TrainSchedule = z
  .string()
  .max(100)
  .refine((expression) => parseCron(expression).ok, 'Not a valid cron expression')
  .openapi({
    description: 'Cron expression (UTC) of the daily release train',
    example: '30 4 * * *',
  });

const BaseUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/[^\s/?#@\\]+(?:\/[^\s?#\\]*)?$/, 'Use an http(s) URL without credentials');

const uniqueList = (values: readonly string[]) => new Set(values).size === values.length;

/** Per-app automation settings: Dependabot auto-merge (L3b) and the release train (L5). */
export const AppAutomationSettings = z
  .object({
    merge: AutomationMode.openapi({
      description: 'Auto-merge of eligible Dependabot pull requests',
    }),
    train: AutomationMode.openapi({ description: 'The daily release train' }),
    paused: z.boolean().openapi({
      description:
        'Stops everything the automation would do next; an App-enabled auto-merge is disabled',
    }),
    trainSchedule: TrainSchedule.nullable(),
    verify: z.object({ baseUrl: BaseUrl.nullable() }),
    holdPaths: z
      .array(RepositoryPathPattern)
      .max(50)
      .refine(uniqueList, 'Paths must be unique')
      .openapi({
        description: 'Paths whose change holds a release for a person (migrations)',
      }),
    dependabotUserId: z.number().int().positive(),
    allowedPaths: z
      .array(RepositoryPathPattern)
      .max(50)
      .refine(uniqueList, 'Paths must be unique')
      .openapi({ description: 'Files a merged Dependabot pull request may change' }),
    holdImages: z
      .array(ImagePrefix)
      .max(20)
      .refine(uniqueList, 'Image names must be unique')
      .openapi({
        description: 'Image name prefixes held for a person unless a minor or patch update',
      }),
  })
  .openapi('AppAutomationSettings');
export type AppAutomationSettings = z.infer<typeof AppAutomationSettings>;

export const DEFAULT_APP_AUTOMATION_SETTINGS: AppAutomationSettings = {
  merge: 'off',
  train: 'off',
  paused: false,
  trainSchedule: null,
  verify: { baseUrl: null },
  holdPaths: [],
  dependabotUserId: DEPENDABOT_USER_ID,
  allowedPaths: [...DEFAULT_AUTOMATION_ALLOWED_PATHS],
  holdImages: [...DEFAULT_AUTOMATION_HOLD_IMAGES],
};

/** Partial update; `verify` is replaced as a whole. */
export const UpdateAppAutomation = z
  .strictObject({
    merge: AutomationMode.optional(),
    train: AutomationMode.optional(),
    paused: z.boolean().optional(),
    trainSchedule: TrainSchedule.nullable().optional(),
    verify: z.strictObject({ baseUrl: BaseUrl.nullable() }).optional(),
    holdPaths: AppAutomationSettings.shape.holdPaths.optional(),
    dependabotUserId: AppAutomationSettings.shape.dependabotUserId.optional(),
    allowedPaths: AppAutomationSettings.shape.allowedPaths.optional(),
    holdImages: AppAutomationSettings.shape.holdImages.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field')
  .openapi('UpdateAppAutomation', {
    description: 'Changing the settings needs an admin session signed in with a passkey',
  });
export type UpdateAppAutomation = z.infer<typeof UpdateAppAutomation>;

/** What the disable sweep of a pause or of a change away from `on` achieved. */
export const AutomationSweep = z
  .object({
    confirmed: z.array(z.number().int()).openapi({
      description: 'Pull requests whose App-enabled auto-merge was disabled',
    }),
    failed: z.array(z.number().int()).openapi({
      description: 'Pull requests whose auto-merge may still be on; the reconcile keeps trying',
    }),
  })
  .openapi('AutomationSweep');
export type AutomationSweep = z.infer<typeof AutomationSweep>;

/** The settings after a change, and the sweep it triggered (null when it withdrew nothing). */
export const AutomationChange = AppAutomationSettings.extend({
  sweep: AutomationSweep.nullable(),
}).openapi('AutomationChange');
export type AutomationChange = z.infer<typeof AutomationChange>;

export const AUTOMATION_RUN_KINDS = ['pr', 'train', 'notice'] as const;
export const AUTOMATION_ACTION_STATUSES = ['pending', 'done', 'refused'] as const;

/** One action of a run: serialisable input, an idempotency key and its stored result. */
export const AutomationActionRecord = z
  .object({
    type: z.string(),
    key: z.string().openapi({ description: 'Idempotency key: an action with this key runs once' }),
    input: z.record(z.string(), z.unknown()),
    status: z.enum(AUTOMATION_ACTION_STATUSES),
    result: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi('AutomationActionRecord');
export type AutomationActionRecord = z.infer<typeof AutomationActionRecord>;

export const AutomationRun = z
  .object({
    id: AutomationRunId,
    appId: AppId,
    kind: z.enum(AUTOMATION_RUN_KINDS),
    key: z.string().openapi({
      description: 'The pull request (`pr-<number>`) or train (`<date>`)',
      example: 'pr-12',
    }),
    state: z.string(),
    snapshot: z.record(z.string(), z.unknown()),
    actions: z.array(AutomationActionRecord),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('AutomationRun');
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunList = list(AutomationRun).openapi('AutomationRunList');
export type AutomationRunList = z.infer<typeof AutomationRunList>;
