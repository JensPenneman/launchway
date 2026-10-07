import { DisplayName, IpAddress, Timestamp } from './common.js';
import { NodeId } from './ids.js';
import { list } from './pagination.js';
import { z } from './zod.js';

/** One-time join tokens: `lwyn_` + 43 base62 characters, valid for 15 minutes. */
export const NODE_JOIN_TOKEN_PREFIX = 'lwyn_';
export const NODE_JOIN_TOKEN_PATTERN = /^lwyn_[0-9A-Za-z]{43}$/;
export const NODE_JOIN_TOKEN_TTL_SECONDS = 15 * 60;
/** Long-lived node credentials issued on join: `lwya_` + 43 base62 characters. */
export const NODE_CREDENTIAL_PREFIX = 'lwya_';
export const NODE_CREDENTIAL_PATTERN = /^lwya_[0-9A-Za-z]{43}$/;

/** Upper bound of `Node.allowedBindRoots`. */
export const MAX_ALLOWED_BIND_ROOTS = 32;

/**
 * A directory below which trusted apps on the node may bind-mount host paths: an absolute,
 * normalized POSIX path as the Docker daemon sees it (`/srv/data`, or on Docker Desktop
 * `/run/desktop/mnt/host/d/Backups`). `/` itself, `.`/`..` segments, empty segments and a
 * trailing slash are refused.
 */
export const BindRoot = z
  .string()
  .max(1024)
  .refine((path) => path.startsWith('/'), 'Must be an absolute path (start with /)')
  .refine((path) => path !== '/', 'The root directory / cannot be an allowed root')
  .refine((path) => !path.endsWith('/'), 'Remove the trailing slash')
  .refine(
    (path) =>
      !path
        .split('/')
        .slice(1)
        .some((segment) => segment === '..'),
    'Must not contain .. segments',
  )
  .refine(
    (path) =>
      !path
        .split('/')
        .slice(1)
        .some((segment) => segment === '' || segment === '.'),
    'Must not contain empty or . segments',
  )
  .refine(
    (path) => ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    'Must not contain control characters',
  )
  .openapi({ example: '/srv/data' });
export type BindRoot = z.infer<typeof BindRoot>;

export const AllowedBindRoots = z
  .array(BindRoot)
  .max(MAX_ALLOWED_BIND_ROOTS)
  .refine((roots) => new Set(roots).size === roots.length, 'Roots must be unique')
  .openapi({
    description:
      'Host directories (daemon-side absolute paths) that apps with trustedMounts may bind-mount from. Admin only.',
    example: ['/srv/data', '/run/desktop/mnt/host/d/Backups'],
  });

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
    allowedBindRoots: AllowedBindRoots,
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

/** Changing `allowedBindRoots` requires the admin role (as does every node change). */
export const UpdateNodeInput = z
  .strictObject({ name: DisplayName.optional(), allowedBindRoots: AllowedBindRoots.optional() })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field')
  .openapi('UpdateNodeInput');
export type UpdateNodeInput = z.infer<typeof UpdateNodeInput>;

export const NodeJoinToken = z
  .object({
    token: z.string().regex(NODE_JOIN_TOKEN_PATTERN).openapi({ description: 'Shown once' }),
    expiresAt: Timestamp,
    serverUrl: z.string().openapi({
      description: 'Value for LAUNCHWAY_SERVER_URL',
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
