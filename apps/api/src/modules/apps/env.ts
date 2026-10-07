import type { AppId } from '@launchway/contracts';
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import type { SecretBox } from '../../lib/crypto.js';
import { envVars } from './schema.js';

/** AAD binding an encrypted value to its app and key. */
export function envContext(appId: AppId, key: string): string {
  return `env:${appId}:${key}`;
}

/** Decrypted environment of an app (for the deploy payload only; never log it). */
export async function loadDecryptedEnv(
  db: Executor,
  secrets: SecretBox,
  appId: AppId,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: envVars.key, valueEncrypted: envVars.valueEncrypted })
    .from(envVars)
    .where(eq(envVars.appId, appId))
    .orderBy(asc(envVars.key));
  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.key] = secrets.decrypt(row.valueEncrypted, envContext(appId, row.key));
  }
  return env;
}
