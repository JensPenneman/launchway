import {
  type AppId,
  type DeploymentId,
  DeployPayload,
  type NodeId,
  resolveAppSource,
  serviceAlias,
} from '@slipway/contracts';
import type { CloneCredentials } from '../../lib/git-provider.js';

export interface DeployPayloadInput {
  readonly deployment: {
    readonly id: DeploymentId;
    readonly ref: string;
    readonly commitSha: string;
    readonly nodeId: NodeId;
  };
  readonly app: {
    readonly id: AppId;
    readonly slug: string;
    readonly composeFiles: readonly string[] | null;
    readonly dockerfile: string | null;
    readonly context: string | null;
  };
  readonly clone: CloneCredentials;
  /** Decrypted environment. */
  readonly env: Readonly<Record<string, string>>;
  /** App routes (`routes` joined with `domains`). Duplicates are collapsed. */
  readonly routes: readonly { readonly service: string; readonly port: number }[];
  readonly proxyNetwork: string;
  /** LAN address of the target node. */
  readonly nodeLanIp: string | null;
  /** `settings.edge_node_id`. */
  readonly edgeNodeId: NodeId | null;
}

/** Raised when the assembled payload violates the agent contract (values are never included). */
export class InvalidDeployPayloadError extends Error {
  override readonly name = 'InvalidDeployPayloadError';
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(`deploy payload is invalid at ${paths.join(', ') || '(root)'}`);
    this.paths = paths;
  }
}

/**
 * Builds the `deploy` request for the agent (spec sections 4 and 9). Routed ports are published
 * on the node's LAN IP only when the app does not run on the edge node, so the edge can reach it.
 * Without an edge node every app counts as local, the same rule the Caddyfile renderer applies
 * (it then reaches every app by its alias on the proxy network).
 */
export function buildDeployPayload(input: DeployPayloadInput): DeployPayload {
  const seen = new Set<string>();
  const routes = [];
  for (const route of [...input.routes].sort(
    (a, b) => a.service.localeCompare(b.service) || a.port - b.port,
  )) {
    const key = `${route.service}:${route.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      service: route.service,
      port: route.port,
      alias: serviceAlias(input.app.slug, route.service),
    });
  }

  const onEdge = input.edgeNodeId === null || input.deployment.nodeId === input.edgeNodeId;
  const candidate = {
    deploymentId: input.deployment.id,
    app: { id: input.app.id, slug: input.app.slug },
    source: {
      cloneUrl: input.clone.cloneUrl,
      ref: input.deployment.ref,
      commitSha: input.deployment.commitSha,
      authorization: input.clone.authorization,
    },
    build: resolveAppSource(input.app),
    env: { ...input.env },
    routes,
    network: {
      proxyNetwork: input.proxyNetwork,
      publishOnIp: onEdge ? null : input.nodeLanIp,
    },
  };
  const parsed = DeployPayload.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidDeployPayloadError(parsed.error.issues.map((issue) => issue.path.join('.')));
  }
  return parsed.data;
}
