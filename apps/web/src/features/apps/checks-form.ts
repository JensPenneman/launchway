import {
  type AppChecksSettings,
  type CheckItemInput,
  DEFAULT_CHECK_SERVICE,
  DEFAULT_CHECK_TIMEOUT_MINUTES,
  UpdateAppChecksSettings,
} from '@launchway/contracts';
import { friendlyMessage } from '@/lib/form';

/** One check as edited in the settings card; every field is the text of its input. */
export interface CheckItemForm {
  name: string;
  command: string;
  /** Empty means the default service (`dev`). */
  service: string;
  /** Whole minutes; empty means the default (30). */
  timeoutMinutes: string;
  /** Empty means the check uses the Compose files of the checks. */
  composeFile: string;
}

/** The check settings of an app as edited in the settings card. */
export interface ChecksForm {
  enabled: boolean;
  /** One path per line. */
  composeFiles: string;
  /** Exact branch names separated by commas, spaces or line breaks; empty means every branch. */
  branches: string;
  skipBots: boolean;
  items: CheckItemForm[];
}

export function toChecksForm(settings: AppChecksSettings): ChecksForm {
  return {
    enabled: settings.enabled,
    composeFiles: settings.composeFiles.join('\n'),
    branches: (settings.branches ?? []).join(', '),
    skipBots: settings.skipBots,
    items: settings.items.map((item) => ({
      name: item.name,
      command: item.command,
      service: item.service,
      timeoutMinutes: String(item.timeoutMinutes),
      composeFile: item.composeFile ?? '',
    })),
  };
}

/** A new, empty check with the default service and timeout filled in. */
export function newCheckItem(): CheckItemForm {
  return {
    name: '',
    command: '',
    service: DEFAULT_CHECK_SERVICE,
    timeoutMinutes: String(DEFAULT_CHECK_TIMEOUT_MINUTES),
    composeFile: '',
  };
}

const splitLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const splitList = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function toItemInput(item: CheckItemForm): CheckItemInput {
  const service = item.service.trim();
  const timeout = item.timeoutMinutes.trim();
  const composeFile = item.composeFile.trim();
  return {
    name: item.name.trim(),
    command: item.command,
    ...(service ? { service } : {}),
    ...(timeout ? { timeoutMinutes: Number(timeout) } : {}),
    ...(composeFile ? { composeFile } : {}),
  };
}

export type ChecksFormResult =
  | { success: true; data: UpdateAppChecksSettings }
  | { success: false; errors: Record<string, string> };

/**
 * Validates the form with the contract schema and maps it to `PATCH /apps/{id}` `checks` (every
 * field, `items` replacing the list). Error keys are form paths: `composeFiles`, `branches`,
 * `items.<index>.<field>` and `items.root`.
 */
export function parseChecksForm(form: ChecksForm): ChecksFormResult {
  const composeFiles = splitLines(form.composeFiles);
  const branches = splitList(form.branches);
  const items = form.items.map(toItemInput);
  const errors: Record<string, string> = {};
  if (composeFiles.length === 0) errors.composeFiles = 'Enter at least one Compose file';

  const parsed = UpdateAppChecksSettings.safeParse(
    {
      enabled: form.enabled,
      composeFiles,
      branches: branches.length === 0 ? null : branches,
      skipBots: form.skipBots,
      items,
    },
    { error: friendlyMessage },
  );
  if (parsed.success && Object.keys(errors).length === 0) {
    return { success: true, data: parsed.data };
  }

  for (const issue of parsed.error?.issues ?? []) {
    const [field, index, key] = issue.path;
    if (field === 'items' && typeof index === 'number' && typeof key === 'string') {
      errors[`items.${index}.${key}`] ??=
        key === 'timeoutMinutes' && issue.code === 'invalid_type'
          ? 'Enter whole minutes'
          : issue.message;
    } else if (field === 'items') {
      // Repeated names are marked on the items below.
      if (issue.code !== 'custom') errors['items.root'] ??= issue.message;
    } else if (field === 'composeFiles' || field === 'branches') {
      const values = field === 'composeFiles' ? composeFiles : branches;
      errors[field] ??=
        typeof index === 'number' ? `${values[index]}: ${issue.message}` : issue.message;
    }
  }
  items.forEach((item, index) => {
    if (item.name !== '' && items.some((other, at) => at !== index && other.name === item.name)) {
      errors[`items.${index}.name`] ??= 'Another check has this name';
    }
  });
  return { success: false, errors };
}
