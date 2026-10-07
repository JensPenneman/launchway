import { type AppSource, type DeployPayload, LAUNCHWAY_LABELS } from '@launchway/contracts';
import type { ComposeConfig } from './compose-policy.js';

/** Generated override, merged last (spec section 4 step 3). */
export const OVERRIDE_FILE = 'compose.launchway.yaml';
/** Synthesized Compose file for apps that only have a Dockerfile. */
export const SYNTHESIZED_FILE = 'compose.launchway.build.yaml';
/** Service name of a synthesized Dockerfile app. */
const SYNTHESIZED_SERVICE = 'app';

/**
 * One-service Compose file for `dockerfile` + `context` sources (paths relative to the repository
 * root). The service receives the app environment through `.env`. JSON is valid YAML, so no YAML
 * serializer is needed.
 */
export function synthesizeCompose(
  source: Extract<AppSource, { kind: 'dockerfile' }>,
  checkoutDir: string,
): Record<string, unknown> {
  return {
    services: {
      [SYNTHESIZED_SERVICE]: {
        build: {
          context: `./${source.context}`,
          dockerfile: `${checkoutDir}/${source.dockerfile}`,
        },
        env_file: [{ path: './.env', required: true }],
        restart: 'unless-stopped',
      },
    },
  };
}

/**
 * The override `compose.launchway.yaml`: labels on every service; for each routed or attached
 * service the external proxy network with its alias (keeping the networks the service already
 * joins, since an override `networks:` would otherwise replace the implicit `default`), and, off
 * the edge node, the routed port published on the node's LAN IP with an ephemeral host port.
 * `attach` entries (services without a route, e.g. a forward-auth gate) never publish a port.
 */
export function buildOverride(
  config: ComposeConfig,
  payload: Pick<DeployPayload, 'app' | 'deploymentId' | 'routes' | 'network'> &
    Partial<Pick<DeployPayload, 'attach'>>,
): Record<string, unknown> {
  const proxy = payload.network.proxyNetwork;
  const services: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(config.services).sort()) {
    services[name] = {
      labels: {
        [LAUNCHWAY_LABELS.app]: payload.app.id,
        [LAUNCHWAY_LABELS.deployment]: payload.deploymentId,
        [LAUNCHWAY_LABELS.service]: name,
      },
    };
  }
  const aliasesByService = new Map<string, Set<string>>();
  const portsByService = new Map<string, Set<number>>();
  for (const route of payload.routes) {
    aliasesByService.set(
      route.service,
      (aliasesByService.get(route.service) ?? new Set()).add(route.alias),
    );
    portsByService.set(
      route.service,
      (portsByService.get(route.service) ?? new Set()).add(route.port),
    );
  }
  for (const entry of payload.attach ?? []) {
    aliasesByService.set(
      entry.service,
      (aliasesByService.get(entry.service) ?? new Set()).add(entry.alias),
    );
  }
  for (const [name, aliases] of aliasesByService) {
    const service = services[name];
    const existing = config.services[name];
    if (!service || !existing) continue;
    const networks: Record<string, unknown> = {};
    const declared = Object.keys(existing.networks ?? {});
    for (const network of declared.length > 0 ? declared : ['default']) networks[network] = {};
    networks[proxy] = { aliases: [...aliases] };
    service.networks = networks;
    const publishOnIp = payload.network.publishOnIp;
    const ports = portsByService.get(name);
    if (publishOnIp && ports) {
      service.ports = [...ports].map((port) => ({
        target: port,
        host_ip: publishOnIp,
        protocol: 'tcp',
      }));
    }
  }
  return { services, networks: { [proxy]: { external: true, name: proxy } } };
}

/** `.env` line for one variable, quoted so Compose reads the value back verbatim. */
function formatEnvValue(value: string): string {
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `"${escaped}"`;
}

/** Contents of `.env`: single quotes keep values literal (no interpolation, no escapes). */
export function formatEnvFile(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${formatEnvValue(env[key] ?? '')}\n`)
    .join('');
}
