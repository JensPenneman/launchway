import { DisplayName, IpAddress, Timestamp } from './common.js';
import { NodeId } from './ids.js';
import { list } from './pagination.js';
import { z } from './zod.js';

/** One-time join tokens: `slpn_` + 43 base62 characters, valid for 15 minutes. */
export const NODE_JOIN_TOKEN_PREFIX = 'slpn_';
export const NODE_JOIN_TOKEN_PATTERN = /^slpn_[0-9A-Za-z]{43}$/;
export const NODE_JOIN_TOKEN_TTL_SECONDS = 15 * 60;
/** Long-lived node credentials issued on join: `slpa_` + 43 base62 characters. */
export const NODE_CREDENTIAL_PREFIX = 'slpa_';
export const NODE_CREDENTIAL_PATTERN = /^slpa_[0-9A-Za-z]{43}$/;

export const NODE_STATUSES = ['pending', 'online', 'offline'] as const;
export const NodeStatus = z.enum(NODE_STATUSES).openapi('NodeStatus', {
  description: 'pending: never joined; online: heartbeat within 45 s; offline: otherwise',
});
export type NodeStatus = z.infer<typeof NodeStatus>;

/** Docker facts reported by the agent in `hello`. */
export const DockerInfo = z
  .object({
    serverVersion: z.string(),
    apiVersion: z.string().nullable(),
    composeVersion: z.string().nullable(),
    operatingSystem: z.string(),
    osType: z.string(),
    kernelVersion: z.string(),
    architecture: z.string(),
    cpus: z.number().int().min(0),
    memoryBytes: z.number().int().min(0),
    storageDriver: z.string().nullable(),
    rootDir: z.string().nullable(),
  })
  .openapi('DockerInfo');
export type DockerInfo = z.infer<typeof DockerInfo>;

export const Node = z
  .object({
    id: NodeId,
    name: DisplayName,
    status: NodeStatus,
    isEdge: z.boolean(),
    lanIp: IpAddress.nullable(),
    hostname: z.string().nullable(),
    arch: z.string().nullable(),
    agentVersion: z.string().nullable(),
    protocolVersion: z.number().int().nullable(),
    docker: DockerInfo.nullable(),
    lastSeenAt: Timestamp.nullable(),
    joinedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Node');
export type Node = z.infer<typeof Node>;

export const NodeList = list(Node).openapi('NodeList');
export type NodeList = z.infer<typeof NodeList>;

export const CreateNodeInput = z.strictObject({ name: DisplayName }).openapi('CreateNodeInput');
export type CreateNodeInput = z.infer<typeof CreateNodeInput>;

export const UpdateNodeInput = z.strictObject({ name: DisplayName }).openapi('UpdateNodeInput');
export type UpdateNodeInput = z.infer<typeof UpdateNodeInput>;

export const NodeJoinToken = z
  .object({
    token: z.string().regex(NODE_JOIN_TOKEN_PATTERN).openapi({ description: 'Shown once' }),
    expiresAt: Timestamp,
    serverUrl: z.string().openapi({
      description: 'Value for SLIPWAY_SERVER_URL',
      example: 'wss://deploy.example.com',
    }),
    dockerRunCommand: z.string(),
    composeSnippet: z.string(),
  })
  .openapi('NodeJoinToken');
export type NodeJoinToken = z.infer<typeof NodeJoinToken>;

export const CreatedNode = z
  .object({ node: Node, joinToken: NodeJoinToken })
  .openapi('CreatedNode');
export type CreatedNode = z.infer<typeof CreatedNode>;
