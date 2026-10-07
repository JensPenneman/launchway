import type { GitHubConnectionId } from '@launchway/contracts';
import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import type { Deps } from '../../deps.js';
import {
  createInstallationProvider,
  createPatProvider,
  type GitHubAppCredentials,
  type GitProvider,
  GitProviderError,
} from '../../lib/git-provider.js';
import { conflict, notFound, ProblemError } from '../../lib/problem.js';
import { githubConnections } from './schema.js';

export type ConnectionRow = typeof githubConnections.$inferSelect;

/** AAD contexts of the encrypted connection columns. */
export const secretContext = {
  token: (id: GitHubConnectionId) => `github:${id}:token`,
  clientSecret: (id: GitHubConnectionId) => `github:${id}:client-secret`,
  privateKey: (id: GitHubConnectionId) => `github:${id}:private-key`,
  webhookSecret: (id: GitHubConnectionId) => `github:${id}:webhook-secret`,
} as const;

export async function findConnection(
  db: Executor,
  id: GitHubConnectionId,
): Promise<ConnectionRow | undefined> {
  const [row] = await db.select().from(githubConnections).where(eq(githubConnections.id, id));
  return row;
}

export async function getConnection(db: Executor, id: GitHubConnectionId): Promise<ConnectionRow> {
  const row = await findConnection(db, id);
  if (!row) throw notFound('GitHub connection not found');
  return row;
}

/** App id + decrypted private key of an `app` connection. */
export function appCredentials(
  deps: Pick<Deps, 'secrets'>,
  row: ConnectionRow,
): GitHubAppCredentials {
  if (row.kind !== 'app' || row.appId === null || row.privateKeyEncrypted === null) {
    throw new Error(`connection ${row.id} is not a GitHub App connection`);
  }
  return {
    appId: row.appId,
    privateKey: deps.secrets.decrypt(row.privateKeyEncrypted, secretContext.privateKey(row.id)),
  };
}

/** The GitProvider of a connection; 409 for an app that is not installed yet. */
export function providerFor(deps: Pick<Deps, 'secrets'>, row: ConnectionRow): GitProvider {
  if (row.kind === 'pat') {
    if (row.tokenEncrypted === null) throw new Error(`connection ${row.id} has no token`);
    return createPatProvider(deps.secrets.decrypt(row.tokenEncrypted, secretContext.token(row.id)));
  }
  if (row.installationId === null) {
    throw conflict('The GitHub App of this connection is not installed on an account yet');
  }
  return createInstallationProvider(appCredentials(deps, row), row.installationId);
}

/** Maps Git host failures to problems; other errors pass through unchanged. */
export function toGitProblem(error: unknown, notFoundDetail = 'Not found on GitHub'): unknown {
  if (!(error instanceof GitProviderError)) return error;
  switch (error.kind) {
    case 'not-found':
      return notFound(notFoundDetail);
    case 'unauthorized':
    case 'forbidden':
      return new ProblemError('upstream-failed', {
        detail: 'GitHub rejected the credentials of this connection or the request',
      });
    default:
      return new ProblemError('upstream-failed', { detail: 'The request to GitHub failed' });
  }
}
