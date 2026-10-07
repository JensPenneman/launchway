import { randomBytes } from 'node:crypto';
import type { AppId, DomainId, NodeId } from '@launchway/contracts';
import type { Database } from '../../src/db/client.js';
import { apps, domains, githubConnections, nodes } from '../../src/db/schema.js';

/** Unique lower-case suffix for names that must not collide between tests. */
export function unique(prefix: string): string {
  return `${prefix}${randomBytes(4).toString('hex')}`;
}

export async function insertNode(db: Database, name = unique('node-')): Promise<NodeId> {
  const [row] = await db.insert(nodes).values({ name }).returning({ id: nodes.id });
  if (!row) throw new Error('node insert failed');
  return row.id;
}

/** An app row (with a throwaway PAT connection) on `nodeId`. */
export async function insertApp(
  db: Database,
  nodeId: NodeId,
  slug = unique('app'),
): Promise<AppId> {
  const [connection] = await db
    .insert(githubConnections)
    .values({ kind: 'pat', name: unique('conn-'), tokenEncrypted: 'not-a-real-ciphertext' })
    .returning({ id: githubConnections.id });
  if (!connection) throw new Error('connection insert failed');
  const [app] = await db
    .insert(apps)
    .values({
      slug,
      name: slug,
      connectionId: connection.id,
      repoOwner: 'example',
      repoName: slug,
      composeFiles: ['compose.yaml'],
      nodeId,
    })
    .returning({ id: apps.id });
  if (!app) throw new Error('app insert failed');
  return app.id;
}

export async function insertDomain(
  db: Database,
  hostname = `${unique('h')}.example.com`,
  status: 'pending' | 'verified' | 'misconfigured' = 'verified',
): Promise<{ id: DomainId; hostname: string }> {
  const [row] = await db
    .insert(domains)
    .values({ hostname, status })
    .returning({ id: domains.id, hostname: domains.hostname });
  if (!row) throw new Error('domain insert failed');
  return row;
}
