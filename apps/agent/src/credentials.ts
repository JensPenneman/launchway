import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_CREDENTIAL_PATTERN, NodeId } from '@slipway/contracts';
import { z } from 'zod';

const StoredCredentials = z.object({
  nodeId: NodeId,
  credential: z.string().regex(NODE_CREDENTIAL_PATTERN),
});
export type StoredCredentials = z.infer<typeof StoredCredentials>;

export function credentialsPath(workspace: string): string {
  return join(workspace, 'agent', 'credentials.json');
}

/** Reads the node credential issued on join; null when the agent has not joined yet. */
export async function loadCredentials(workspace: string): Promise<StoredCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(workspace), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return StoredCredentials.parse(JSON.parse(raw));
}

/** Persists the node credential atomically with mode 0600 (directory 0700). */
export async function saveCredentials(
  workspace: string,
  credentials: StoredCredentials,
): Promise<void> {
  const target = credentialsPath(workspace);
  await mkdir(join(workspace, 'agent'), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(StoredCredentials.parse(credentials))}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
}
