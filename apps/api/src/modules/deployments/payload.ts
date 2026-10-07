import {
  type AppId,
  type AppPreviewSettings,
  type DeploymentId,
  DeployPayload,
  type ForwardAuthTarget,
  type NodeId,
  PLATFORM_ENV_PREFIX,
  type PlatformEnvKey,
  previewSlug,
  renderPreviewEnvOverrides,
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
  /**
   * Set for a deployment of a pull request preview. The agent gets the preview's own app id and
   * slug (`<slug>-pr-<number>`), so the Compose project and the aliases are the preview's; routes
   * must then be the preview's route only.
   */
  readonly preview?: {
    readonly number: number;
    /** `previewAgentAppId(preview.id)`. */
    readonly agentAppId: AppId;
    readonly branch: string;
    /** Host name of the preview (`{{previewHost}}`). */
    readonly hostname: string;
    readonly envOverrides: AppPreviewSettings['envOverrides'];
    /** Compose files of previews; null uses the app's source. */
    readonly composeFiles: readonly string[] | null;
  };
  /**
   * Host name of the first route (`LAUNCHWAY_PUBLIC_URL` = `https://<host>`); for a preview its
   * own host name. Null when the app has no route.
   */
  readonly publicHostname?: string | null;
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

/** `https://<host>` of the deployment's first route, or an empty string without a route. */
function publicUrl(input: DeployPayloadInput): string {
  const host = input.preview?.hostname ?? input.publicHostname ?? null;
  return host ? `https://${host}` : '';
}

/**
 * The `LAUNCHWAY_*` variables of a deployment (spec section 4). `LAUNCHWAY_APP` and
 * `LAUNCHWAY_APP_ID` name the app also in previews; `LAUNCHWAY_PREVIEW_NUMBER` is empty in
 * production.
 */
export function platformEnv(input: DeployPayloadInput): Record<PlatformEnvKey, string> {
  return {
    LAUNCHWAY_APP: input.app.slug,
    LAUNCHWAY_APP_ID: input.app.id,
    LAUNCHWAY_DEPLOYMENT_ID: input.deployment.id,
    LAUNCHWAY_REF: input.deployment.ref,
    LAUNCHWAY_COMMIT_SHA: input.deployment.commitSha,
    LAUNCHWAY_COMMIT_SHA_SHORT: input.deployment.commitSha.slice(0, 7),
    LAUNCHWAY_NODE: input.node.name,
    LAUNCHWAY_ENVIRONMENT: input.preview ? 'preview' : 'production',
    LAUNCHWAY_PREVIEW_NUMBER: input.preview ? String(input.preview.number) : '',
    LAUNCHWAY_PUBLIC_URL: publicUrl(input),
  };
}

/**
 * The deployment's environment: the app's variables, for a preview with its overrides applied
 * (placeholders filled), then the platform variables. `LAUNCHWAY_*` keys from storage or overrides
 * never shadow the platform's.
 */
export function deploymentEnv(input: DeployPayloadInput): Record<string, string> {
  const env: Record<string, string> = {};
  const overrides = input.preview
    ? renderPreviewEnvOverrides(input.preview.envOverrides, {
        previewUrl: publicUrl(input),
        previewHost: input.preview.hostname,
        prNumber: input.preview.number,
        branch: input.preview.branch,
        sha: input.deployment.commitSha,
      })
    : {};
  for (const [key, value] of Object.entries({ ...input.env, ...overrides })) {
    // The contracts refuse such keys; rows stored before that rule must not shadow the platform.
    if (!key.startsWith(PLATFORM_ENV_PREFIX)) env[key] = value;
  }
  return Object.assign(env, platformEnv(input));
}

/**
 * Services joining the proxy network: the services of the app's routes, its `proxyServices` and
 * the forward-auth target service when it belongs to this app. Sorted and unique. A preview
 * attaches only its routed services: nothing calls its other services by alias.
 */
function attachedServices(input: DeployPayloadInput): string[] {
  const services = new Set<string>(input.routes.map((route) => route.service));
  if (input.preview) return [...services].sort();
  for (const service of input.app.proxyServices) services.add(service);
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
 * Previews never get the mount trust: they would share host paths and volumes with production
 * (ADR 0018).
 */
export function buildDeployPayload(input: DeployPayloadInput): DeployPayload {
  const preview = input.preview;
  const slug = preview ? previewSlug(input.app.slug, preview.number) : input.app.slug;
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
      alias: serviceAlias(input.app.slug, route.service, preview?.number),
    });
  }

  const onEdge = input.edgeNodeId === null || input.deployment.nodeId === input.edgeNodeId;
  const candidate = {
    deploymentId: input.deployment.id,
    app: { id: preview?.agentAppId ?? input.app.id, slug },
    source: {
      cloneUrl: input.clone.cloneUrl,
      ref: input.deployment.ref,
      commitSha: input.deployment.commitSha,
      authorization: input.clone.authorization,
    },
    build: resolveAppSource(
      preview?.composeFiles ? { composeFiles: preview.composeFiles } : input.app,
    ),
    env: deploymentEnv(input),
    routes,
    attach: attachedServices(input).map((service) => ({
      service,
      alias: serviceAlias(input.app.slug, service, preview?.number),
    })),
    network: {
      proxyNetwork: input.proxyNetwork,
      publishOnIp: onEdge ? null : input.nodeLanIp,
    },
    policy: {
      trustedMounts: preview ? false : input.app.trustedMounts,
      allowedBindRoots: preview ? [] : [...input.nodeAllowedBindRoots],
    },
  };
  const parsed = DeployPayload.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidDeployPayloadError(parsed.error.issues.map((issue) => issue.path.join('.')));
  }
  return parsed.data;
}
