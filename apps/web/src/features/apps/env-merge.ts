import type { EnvVar, SetEnvVarsInput, z } from '@launchway/contracts';
import type { DotenvEntry } from '@/lib/dotenv';

type BulkVariables = z.input<typeof SetEnvVarsInput>['variables'];

/**
 * Bulk payload for pasted `.env` content: pasted keys get their new value (secret when asked or
 * when the key already was secret); existing keys that were not pasted are sent without a value,
 * which keeps them unchanged whether the API treats PUT as replace or as upsert.
 */
export function mergeEnvForBulk(
  existing: readonly EnvVar[],
  pasted: readonly DotenvEntry[],
  markSecret: boolean,
): BulkVariables {
  const pastedKeys = new Map(pasted.map((entry) => [entry.key, entry.value]));
  const result: BulkVariables = existing
    .filter((variable) => !pastedKeys.has(variable.key))
    .map((variable) => ({ key: variable.key, secret: variable.secret }));
  for (const entry of pasted) {
    const previous = existing.find((variable) => variable.key === entry.key);
    result.push({
      key: entry.key,
      value: entry.value,
      secret: markSecret || previous?.secret === true,
    });
  }
  return result;
}
