import {
  type HelloPayload,
  NODE_CREDENTIAL_PATTERN,
  NODE_CREDENTIAL_PREFIX,
  NODE_JOIN_TOKEN_PATTERN,
  type NodeId,
} from '@slipway/contracts';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { recordAudit } from '../audit/service.js';
import { nodes } from './schema.js';

/** Result of authenticating an agent's upgrade request. */
export interface AgentAuth {
  readonly nodeId: NodeId;
  /** `join`: a one-time join token (a credential is issued at hello); `credential`: slpa_. */
  readonly via: 'join' | 'credential';
  readonly tokenHash: string;
}

export type HandshakeOutcome =
  | {
      readonly ok: true /** New node credential, only after joining. */;
      readonly credential: string | null;
    }
  | { readonly ok: false };

/** Node state the agent gateway reads and writes. */
export interface NodeAgentStore {
  authenticate(token: string): Promise<AgentAuth | null>;
  /**
   * Re-checks the token (it may have been used or revoked since the upgrade), issues a credential
   * when joining, stores the hello facts and marks the node online.
   */
  completeHandshake(auth: AgentAuth, hello: HelloPayload): Promise<HandshakeOutcome>;
  touch(nodeId: NodeId, at: Date): Promise<void>;
  markOffline(nodeId: NodeId): Promise<void>;
  /** Marks every `online` node offline and returns them (startup: no socket survives). */
  markAllOffline(): Promise<NodeId[]>;
}

const joinTokenValid = () =>
  or(isNull(nodes.joinTokenExpiresAt), gt(nodes.joinTokenExpiresAt, sql`now()`));

function agentActor(nodeId: NodeId, name: string): RequestActor {
  return {
    principal: null,
    ipAddress: null,
    userAgent: null,
    requestId: `agent:${nodeId}`,
    actor: { type: 'agent', id: nodeId, label: name },
  };
}

function helloColumns(hello: HelloPayload, now: Date) {
  return {
    status: 'online' as const,
    hostname: hello.hostname || null,
    arch: hello.platform.arch,
    agentVersion: hello.agentVersion,
    protocolVersion: hello.protocolVersion,
    lanIp: hello.lanIp,
    dockerInfo: hello.docker,
    lastSeenAt: now,
    joinedAt: sql`coalesce(${nodes.joinedAt}, ${now.toISOString()}::timestamptz)`,
  };
}

/** PostgreSQL implementation of the gateway's node store. */
export function createNodeAgentStore(deps: { db: Database }): NodeAgentStore {
  const { db } = deps;
  return {
    async authenticate(token) {
      const tokenHash = hashToken(token);
      if (NODE_JOIN_TOKEN_PATTERN.test(token)) {
        const [row] = await db
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.joinTokenHash, tokenHash), joinTokenValid()));
        return row ? { nodeId: row.id, via: 'join', tokenHash } : null;
      }
      if (NODE_CREDENTIAL_PATTERN.test(token)) {
        const [row] = await db
          .select({ id: nodes.id })
          .from(nodes)
          .where(eq(nodes.credentialHash, tokenHash));
        return row ? { nodeId: row.id, via: 'credential', tokenHash } : null;
      }
      return null;
    },

    async completeHandshake(auth, hello) {
      const now = new Date();
      if (auth.via === 'credential') {
        const [row] = await db
          .update(nodes)
          .set(helloColumns(hello, now))
          .where(and(eq(nodes.id, auth.nodeId), eq(nodes.credentialHash, auth.tokenHash)))
          .returning({ id: nodes.id });
        return row ? { ok: true, credential: null } : { ok: false };
      }
      return db.transaction(async (tx) => {
        const [node] = await tx
          .select({ id: nodes.id, name: nodes.name, joinTokenExpiresAt: nodes.joinTokenExpiresAt })
          .from(nodes)
          .where(
            and(
              eq(nodes.id, auth.nodeId),
              eq(nodes.joinTokenHash, auth.tokenHash),
              joinTokenValid(),
            ),
          )
          .for('update');
        if (!node) return { ok: false } as const;
        const credential = generateToken(NODE_CREDENTIAL_PREFIX);
        // Join tokens are single-use; the local bootstrap token (no expiry) stays valid so the
        // bundled agent can rejoin after losing its volume.
        const reusable = node.joinTokenExpiresAt === null;
        await tx
          .update(nodes)
          .set({
            ...helloColumns(hello, now),
            credentialHash: hashToken(credential),
            credentialIssuedAt: now,
            ...(reusable ? {} : { joinTokenHash: null, joinTokenExpiresAt: null }),
          })
          .where(eq(nodes.id, node.id));
        await recordAudit(tx, agentActor(node.id, node.name), {
          action: 'node.join',
          target: { type: 'node', id: node.id },
          summary: {
            agentVersion: hello.agentVersion,
            hostname: hello.hostname,
            arch: hello.platform.arch,
          },
        });
        return { ok: true, credential } as const;
      });
    },

    async touch(nodeId, at) {
      await db
        .update(nodes)
        // Heartbeats are not edits: keep updated_at.
        .set({ lastSeenAt: at, updatedAt: sql`${nodes.updatedAt}` })
        .where(and(eq(nodes.id, nodeId), eq(nodes.status, 'online')));
    },

    async markOffline(nodeId) {
      await db
        .update(nodes)
        .set({ status: 'offline' })
        .where(and(eq(nodes.id, nodeId), eq(nodes.status, 'online')));
    },

    async markAllOffline() {
      const rows = await db
        .update(nodes)
        .set({ status: 'offline' })
        .where(eq(nodes.status, 'online'))
        .returning({ id: nodes.id });
      return rows.map((row) => row.id);
    },
  };
}
