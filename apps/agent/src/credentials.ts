import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_CREDENTIAL_PATTERN, NodeId } from '@launchway/contracts';
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

/**
 * Picks the bearer token of the next connection attempt: the stored node credential, or the join
 * token before joining. When the server refuses the stored credential (for example after the
 * control plane's database was restored from a backup) and a join token is configured, the agent
 * joins again with it; the bundled agent's bootstrap token stays valid for exactly this.
 */
export interface TokenSource {
  token(): string | null;
  /** The server refused the current token; true when the next attempt uses the join token. */
  refused(): boolean;
  /** A new credential arrived with `hello.ok`. */
  store(credentials: StoredCredentials): void;
}

export function createTokenSource(
  stored: StoredCredentials | null,
  joinToken: string | null,
): TokenSource {
  let credentials = stored;
  let useJoinToken = credentials === null;
  return {
    token: () => (useJoinToken ? joinToken : (credentials?.credential ?? null)),
    refused() {
      if (useJoinToken || joinToken === null) return false;
      useJoinToken = true;
      return true;
    },
    store(next) {
      credentials = next;
      useJoinToken = false;
    },
  };
}
