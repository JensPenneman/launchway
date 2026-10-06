import {
  AGENT_CLOSE_CODES,
  type CreatedNode,
  type CreateNodeInput,
  NODE_CREDENTIAL_PREFIX,
  NODE_JOIN_TOKEN_PREFIX,
  NODE_JOIN_TOKEN_TTL_SECONDS,
  type Node,
  type NodeId,
  type NodeJoinToken,
  type NodeList,
  type UpdateNodeInput,
} from '@slipway/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import { type RequestActor, systemActor } from '../../lib/auth-context.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { conflict, notFound } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { settings } from '../settings/schema.js';
import { createSettingsService } from '../settings/service.js';
import { NodeAgentGateway } from './gateway.js';
import { agentServerUrl, joinInstructions } from './join.js';
import { nodes } from './schema.js';

type NodeRow = typeof nodes.$inferSelect;

/** Name of the node the bundled agent joins with SLIPWAY_LOCAL_JOIN_TOKEN. */
export const LOCAL_NODE_NAME = 'local';

/** Serializes the local bootstrap across API processes. */
const LOCAL_NODE_LOCK = sql`pg_advisory_xact_lock(hashtext('slipway:nodes:local'))`;

type NodesDeps = Pick<Deps, 'db' | 'config' | 'events' | 'agents' | 'version'>;

export interface NodesService {
  list(): Promise<NodeList>;
  get(id: NodeId): Promise<Node>;
  /** `requestOrigin` is the fallback for SLIPWAY_SERVER_URL while no public URL is set. */
  create(input: CreateNodeInput, actor: RequestActor, requestOrigin: string): Promise<CreatedNode>;
  update(id: NodeId, input: UpdateNodeInput, actor: RequestActor): Promise<Node>;
  remove(id: NodeId, actor: RequestActor): Promise<void>;
  issueJoinToken(id: NodeId, actor: RequestActor, requestOrigin: string): Promise<NodeJoinToken>;
  rotateCredential(id: NodeId, actor: RequestActor): Promise<Node>;
  revokeCredential(id: NodeId, actor: RequestActor): Promise<Node>;
}

function toNode(row: NodeRow, edgeNodeId: NodeId | null): Node {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    isEdge: row.id === edgeNodeId,
    lanIp: row.lanIp,
    hostname: row.hostname,
    arch: row.arch,
    agentVersion: row.agentVersion,
    protocolVersion: row.protocolVersion,
    docker: row.dockerInfo,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    joinedAt: row.joinedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function gatewayOf(deps: Pick<Deps, 'agents'>): NodeAgentGateway | null {
  return deps.agents instanceof NodeAgentGateway ? deps.agents : null;
}

export function createNodesService(deps: NodesDeps): NodesService {
  async function readSettings(db: Executor) {
    const [row] = await db
      .select({ edgeNodeId: settings.edgeNodeId, publicUrl: settings.publicUrl })
      .from(settings)
      .where(eq(settings.id, 1));
    return { edgeNodeId: row?.edgeNodeId ?? null, publicUrl: row?.publicUrl ?? null };
  }

  async function loadRow(db: Executor, id: NodeId, forUpdate = false): Promise<NodeRow> {
    const query = db.select().from(nodes).where(eq(nodes.id, id));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound(`Node ${id} does not exist`);
    return row;
  }

  async function present(row: NodeRow): Promise<Node> {
    return toNode(row, (await readSettings(deps.db)).edgeNodeId);
  }

  /** Stores a fresh join token on the node (inside `tx`) and builds the join instructions. */
  async function newJoinToken(
    tx: Executor,
    nodeId: NodeId,
    requestOrigin: string,
  ): Promise<NodeJoinToken> {
    const token = generateToken(NODE_JOIN_TOKEN_PREFIX);
    const expiresAt = new Date(Date.now() + NODE_JOIN_TOKEN_TTL_SECONDS * 1000);
    await tx
      .update(nodes)
      .set({ joinTokenHash: hashToken(token), joinTokenExpiresAt: expiresAt })
      .where(eq(nodes.id, nodeId));
    const { publicUrl } = await readSettings(tx);
    const serverUrl = agentServerUrl(deps.config.publicUrl ?? publicUrl ?? requestOrigin);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      serverUrl,
      ...joinInstructions({ serverUrl, token, version: deps.version, expiresAt }),
    };
  }

  return {
    async list() {
      const [rows, { edgeNodeId }] = await Promise.all([
        deps.db.select().from(nodes).orderBy(asc(nodes.createdAt), asc(nodes.id)),
        readSettings(deps.db),
      ]);
      return { items: rows.map((row) => toNode(row, edgeNodeId)) };
    },

    async get(id) {
      return present(await loadRow(deps.db, id));
    },

    async create(input, actor, requestOrigin) {
      let result: { row: NodeRow; joinToken: NodeJoinToken };
      try {
        result = await deps.db.transaction(async (tx) => {
          const [inserted] = await tx.insert(nodes).values({ name: input.name }).returning();
          if (!inserted) throw new Error('node insert returned no row');
          const joinToken = await newJoinToken(tx, inserted.id, requestOrigin);
          await recordAudit(tx, actor, {
            action: 'node.create',
            target: { type: 'node', id: inserted.id },
            summary: { name: inserted.name },
          });
          return { row: await loadRow(tx, inserted.id), joinToken };
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(`A node named "${input.name}" already exists`);
        throw error;
      }
      deps.events.publish({ topic: 'nodes', action: 'created', resourceId: result.row.id });
      return { node: await present(result.row), joinToken: result.joinToken };
    },

    async update(id, input, actor) {
      let row: NodeRow;
      try {
        row = await deps.db.transaction(async (tx) => {
          const before = await loadRow(tx, id, true);
          const [after] = await tx
            .update(nodes)
            .set({ name: input.name })
            .where(eq(nodes.id, id))
            .returning();
          if (!after) throw notFound(`Node ${id} does not exist`);
          await recordAudit(tx, actor, {
            action: 'node.update',
            target: { type: 'node', id },
            summary: diffSummary(before, after, ['name']),
          });
          return after;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(`A node named "${input.name}" already exists`);
        throw error;
      }
      deps.events.publish({ topic: 'nodes', action: 'updated', resourceId: id });
      return present(row);
    },

    async remove(id, actor) {
      try {
        await deps.db.transaction(async (tx) => {
          const node = await loadRow(tx, id, true);
          const [usage] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(apps)
            .where(eq(apps.nodeId, id));
          if ((usage?.count ?? 0) > 0) {
            throw conflict(
              `${usage?.count} app(s) run on node "${node.name}"; move or delete them first`,
            );
          }
          await tx.delete(nodes).where(eq(nodes.id, id));
          await recordAudit(tx, actor, {
            action: 'node.delete',
            target: { type: 'node', id },
            summary: { name: node.name },
          });
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw conflict('The node is still referenced by deployments and cannot be deleted');
        }
        throw error;
      }
      gatewayOf(deps)?.disconnect(id, AGENT_CLOSE_CODES.revoked, 'node deleted');
      deps.events.publish({ topic: 'nodes', action: 'deleted', resourceId: id });
    },

    async issueJoinToken(id, actor, requestOrigin) {
      const joinToken = await deps.db.transaction(async (tx) => {
        await loadRow(tx, id, true);
        const issued = await newJoinToken(tx, id, requestOrigin);
        await recordAudit(tx, actor, {
          action: 'node.join-token.create',
          target: { type: 'node', id },
          summary: { expiresAt: issued.expiresAt },
        });
        return issued;
      });
      deps.events.publish({ topic: 'nodes', action: 'updated', resourceId: id });
      return joinToken;
    },

    async rotateCredential(id, actor) {
      const gateway = gatewayOf(deps);
      const row = await deps.db.transaction(async (tx) => {
        const node = await loadRow(tx, id, true);
        if (!node.credentialHash) throw conflict('The node has not joined; issue a join token');
        if (!gateway?.isOnline(id)) {
          throw conflict(
            'The agent must be online to receive a rotated credential. Revoke the credential and rejoin the node with a new join token instead.',
          );
        }
        const credential = generateToken(NODE_CREDENTIAL_PREFIX);
        const [after] = await tx
          .update(nodes)
          .set({ credentialHash: hashToken(credential), credentialIssuedAt: new Date() })
          .where(eq(nodes.id, id))
          .returning();
        if (!after) throw notFound(`Node ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'node.credential.rotate',
          target: { type: 'node', id },
        });
        // Delivered before commit: if the agent cannot get it, the old credential stays valid.
        if (!gateway.pushCredential(id, credential)) {
          throw conflict('The agent disconnected before it received the new credential');
        }
        return after;
      });
      deps.events.publish({ topic: 'nodes', action: 'updated', resourceId: id });
      return present(row);
    },

    async revokeCredential(id, actor) {
      const row = await deps.db.transaction(async (tx) => {
        const before = await loadRow(tx, id, true);
        const [after] = await tx
          .update(nodes)
          .set({
            credentialHash: null,
            credentialIssuedAt: null,
            joinTokenHash: null,
            joinTokenExpiresAt: null,
            status: before.status === 'online' ? 'offline' : before.status,
          })
          .where(eq(nodes.id, id))
          .returning();
        if (!after) throw notFound(`Node ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'node.credential.revoke',
          target: { type: 'node', id },
          summary: { hadCredential: before.credentialHash !== null },
        });
        return after;
      });
      gatewayOf(deps)?.disconnect(id, AGENT_CLOSE_CODES.revoked, 'credential revoked');
      deps.events.publish({ topic: 'nodes', action: 'updated', resourceId: id });
      return present(row);
    },
  };
}

/**
 * Startup task: when SLIPWAY_LOCAL_JOIN_TOKEN is configured, make sure a node named `local`
 * exists and accepts that token (without expiry, so the bundled agent can always rejoin), and
 * make it the edge node while none is set. Returns the local node id, or null when not configured.
 */
export async function ensureLocalNode(
  deps: Pick<Deps, 'db' | 'config' | 'events' | 'logger'>,
): Promise<NodeId | null> {
  const token = deps.config.localJoinToken;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const actor = systemActor('local-node-bootstrap');

  const { id, created } = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select ${LOCAL_NODE_LOCK}`);
    const [existing] = await tx
      .select()
      .from(nodes)
      .where(eq(nodes.name, LOCAL_NODE_NAME))
      .for('update');
    if (!existing) {
      const [inserted] = await tx
        .insert(nodes)
        .values({ name: LOCAL_NODE_NAME, joinTokenHash: tokenHash, joinTokenExpiresAt: null })
        .returning({ id: nodes.id });
      if (!inserted) throw new Error('node insert returned no row');
      await recordAudit(tx, actor, {
        action: 'node.create',
        target: { type: 'node', id: inserted.id },
        summary: { name: LOCAL_NODE_NAME, bootstrap: true },
      });
      return { id: inserted.id, created: true };
    }
    if (existing.joinTokenHash !== tokenHash || existing.joinTokenExpiresAt !== null) {
      await tx
        .update(nodes)
        .set({ joinTokenHash: tokenHash, joinTokenExpiresAt: null })
        .where(eq(nodes.id, existing.id));
    }
    return { id: existing.id, created: false };
  });
  if (created) {
    deps.logger.info({ nodeId: id }, 'created the local node for the bundled agent');
    deps.events.publish({ topic: 'nodes', action: 'created', resourceId: id });
  }

  const settingsService = createSettingsService(deps);
  if ((await settingsService.get()).edgeNodeId === null) {
    await settingsService.update({ edgeNodeId: id }, actor);
    deps.logger.info({ nodeId: id }, 'made the local node the edge node');
  }
  return id;
}
