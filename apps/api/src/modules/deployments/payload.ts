import {
  type AppId,
  type DeploymentId,
  DeployPayload,
  type ForwardAuthTarget,
  type NodeId,
  PLATFORM_ENV_PREFIX,
  type PlatformEnvKey,
  resolveAppSource,
  serviceAlias,
} from '@launchway/contracts';
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
    /** `apps.trusted_mounts`. */
    readonly trustedMounts: boolean;
    /** `App.proxyServices`: attached to the proxy network without a route. */
    readonly proxyServices: readonly string[];
  };
  /** The node that runs the deployment (`LAUNCHWAY_NODE`). */
  readonly node: { readonly name: string };
  readonly clone: CloneCredentials;
  /** Decrypted user environment; `LAUNCHWAY_*` keys are replaced by the platform variables. */
  readonly env: Readonly<Record<string, string>>;
  /** App routes (`routes` joined with `domains`). Duplicates are collapsed. */
  readonly routes: readonly { readonly service: string; readonly port: number }[];
  /** `settings.forward_auth_target`; its service is attached when it belongs to this app. */
  readonly forwardAuthTarget: ForwardAuthTarget | null;
  readonly proxyNetwork: string;
  /** LAN address of the target node. */
  readonly nodeLanIp: string | null;
  /** `nodes.allowed_bind_roots` of the target node. */
  readonly nodeAllowedBindRoots: readonly string[];
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

/** The `LAUNCHWAY_*` variables of a deployment (spec section 4). */
export function platformEnv(input: DeployPayloadInput): Record<PlatformEnvKey, string> {
  return {
    LAUNCHWAY_APP: input.app.slug,
    LAUNCHWAY_APP_ID: input.app.id,
    LAUNCHWAY_DEPLOYMENT_ID: input.deployment.id,
    LAUNCHWAY_REF: input.deployment.ref,
    LAUNCHWAY_COMMIT_SHA: input.deployment.commitSha,
    LAUNCHWAY_COMMIT_SHA_SHORT: input.deployment.commitSha.slice(0, 7),
    LAUNCHWAY_NODE: input.node.name,
  };
}

/**
 * Services joining the proxy network: the services of the app's routes, its `proxyServices` and
 * the forward-auth target service when it belongs to this app. Sorted and unique.
 */
function attachedServices(input: DeployPayloadInput): string[] {
  const services = new Set<string>([
    ...input.routes.map((route) => route.service),
    ...input.app.proxyServices,
  ]);
  if (input.forwardAuthTarget?.appId === input.app.id) {
    services.add(input.forwardAuthTarget.service);
  }
  return [...services].sort();
}

/**
 * Builds the `deploy` request for the agent (spec sections 4 and 9). The environment gets the
 * `LAUNCHWAY_*` platform variables. Routed ports are published
 * on the node's LAN IP only when the app does not run on the edge node, so the edge can reach it.
 * Without an edge node every app counts as local, the same rule the Caddyfile renderer applies
 * (it then reaches every app by its alias on the proxy network). `policy` carries the mount trust:
 * the app's admin decision plus the target node's allowed roots (ADR 0015); the agent enforces it.
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

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    // The contracts refuse such keys; rows stored before that rule must not shadow the platform.
    if (!key.startsWith(PLATFORM_ENV_PREFIX)) env[key] = value;
  }
  Object.assign(env, platformEnv(input));

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
    env,
    routes,
    attach: attachedServices(input).map((service) => ({
      service,
      alias: serviceAlias(input.app.slug, service),
    })),
    network: {
      proxyNetwork: input.proxyNetwork,
      publishOnIp: onEdge ? null : input.nodeLanIp,
    },
    policy: {
      trustedMounts: input.app.trustedMounts,
      allowedBindRoots: [...input.nodeAllowedBindRoots],
    },
  };
  const parsed = DeployPayload.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidDeployPayloadError(parsed.error.issues.map((issue) => issue.path.join('.')));
  }
  return parsed.data;
}
