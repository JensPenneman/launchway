import { resolve } from 'node:path';
import {
  DEFAULT_PROXY_NETWORK,
  type DeployRoute,
  RESERVED_SERVICE_NAMES,
} from '@launchway/contracts';
import { z } from 'zod';

/** Capabilities an app may add (`cap_add`); everything else is refused. */
export const ALLOWED_CAPABILITIES: readonly string[] = [
  'NET_BIND_SERVICE',
  'CHOWN',
  'SETUID',
  'SETGID',
  'DAC_OVERRIDE',
  'FOWNER',
];

const MOUNT_TYPES_ALLOWED = ['volume', 'tmpfs', 'image'];
/** `driver_opts.type` values the local volume driver may mount (network filesystems and tmpfs). */
const VOLUME_TYPES_ALLOWED = ['nfs', 'nfs4', 'cifs', 'smb3', 'tmpfs'];
/** Namespace modes that stay inside the container (besides `service:<name>`). */
const PRIVATE_NAMESPACE_MODES = ['private', 'shareable', 'none'];
const NamespaceMode = z.string().nullish();

const PortSpec = z.looseObject({
  target: z.union([z.number(), z.string()]),
  published: z.union([z.string(), z.number()]).nullish(),
  host_ip: z.string().nullish(),
  protocol: z.string().nullish(),
});

const Service = z.looseObject({
  privileged: z.boolean().nullish(),
  network_mode: z.string().nullish(),
  pid: NamespaceMode,
  ipc: NamespaceMode,
  uts: NamespaceMode,
  userns_mode: NamespaceMode,
  cgroup: NamespaceMode,
  cap_add: z.array(z.string()).nullish(),
  security_opt: z.array(z.string()).nullish(),
  devices: z.array(z.unknown()).nullish(),
  device_cgroup_rules: z.array(z.string()).nullish(),
  cgroup_parent: z.string().nullish(),
  runtime: z.string().nullish(),
  gpus: z.unknown().optional(),
  deploy: z
    .looseObject({
      resources: z
        .looseObject({
          reservations: z.looseObject({ devices: z.array(z.unknown()).nullish() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
  volumes_from: z.array(z.string()).nullish(),
  container_name: z.string().nullish(),
  provider: z.unknown().optional(),
  use_api_socket: z.boolean().nullish(),
  volumes: z.array(z.looseObject({ type: z.string(), source: z.string().nullish() })).nullish(),
  networks: z.record(z.string(), z.unknown()).nullish(),
  ports: z.array(PortSpec).nullish(),
  env_file: z.array(z.union([z.string(), z.looseObject({ path: z.string() })])).nullish(),
  label_file: z.array(z.string()).nullish(),
  build: z
    .looseObject({
      context: z.string().nullish(),
      dockerfile: z.string().nullish(),
      additional_contexts: z
        .union([z.record(z.string(), z.string()), z.array(z.string())])
        .nullish(),
      network: z.string().nullish(),
      privileged: z.boolean().nullish(),
      entitlements: z.array(z.string()).nullish(),
    })
    .nullish(),
});

const Volume = z
  .looseObject({
    name: z.string().nullish(),
    external: z.unknown().optional(),
    driver: z.string().nullish(),
    driver_opts: z.record(z.string(), z.union([z.string(), z.number()])).nullish(),
  })
  .nullable();
const Network = z
  .looseObject({
    name: z.string().nullish(),
    external: z.unknown().optional(),
    driver: z.string().nullish(),
    driver_opts: z.record(z.string(), z.unknown()).nullish(),
  })
  .nullable();
const FileObject = z
  .looseObject({ file: z.string().nullish(), external: z.unknown().optional() })
  .nullable();

/** The parts of `docker compose config --format json --no-env-resolution` the policy reads. */
export const ComposeConfig = z.looseObject({
  services: z.record(z.string(), Service),
  volumes: z.record(z.string(), Volume).nullish(),
  networks: z.record(z.string(), Network).nullish(),
  configs: z.record(z.string(), FileObject).nullish(),
  secrets: z.record(z.string(), FileObject).nullish(),
});
export type ComposeConfig = z.infer<typeof ComposeConfig>;

export interface PolicyContext {
  /** `launchway-<slug>`; project-owned volumes are named `<project>_<key>`. */
  projectName: string;
  proxyNetwork: string;
  routes: readonly DeployRoute[];
  /** True when an absolute path lies inside the checkout (symlinks resolved). */
  isInsideCheckout: (path: string) => boolean;
}

export interface DeclaredPort {
  service: string;
  containerPort: string;
  hostPort: string | null;
  hostIp: string | null;
  protocol: string;
}

export interface PolicyResult {
  violations: string[];
  /** Host ports the app publishes itself (reported, not refused). */
  ports: DeclaredPort[];
}

const isExternal = (value: unknown) =>
  value === true || (typeof value === 'object' && value !== null);
/** Only `service:<name>` of a service in the same project may share a namespace. */
const isOwnService = (value: string, services: Record<string, unknown>) =>
  value.startsWith('service:') && Object.hasOwn(services, value.slice('service:'.length));
/** `no-new-privileges` is the only security option an app may set. */
const isAllowedSecurityOpt = (value: string) => /^no-new-privileges([:=]true)?$/i.test(value);
/** Local build contexts are absolute after Compose resolved them; URLs and `target:` are remote. */
const isLocalPath = (value: string) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

function normalizeCapability(cap: string): string {
  return cap.toUpperCase().replace(/^CAP_/, '');
}

/** Parses Compose output; `null` when the shape is not what the policy understands. */
export function parseComposeConfig(json: string): ComposeConfig | null {
  try {
    const parsed = ComposeConfig.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Compose policy (spec section 4): refuses anything that reaches outside the app's own sandbox —
 * host mounts and namespaces, privileges, extra capabilities, files outside the checkout, foreign
 * volumes and networks, and the proxy network (only the generated override may attach it).
 * Published ports are allowed and returned so they can be reported.
 */
export function evaluateComposePolicy(config: ComposeConfig, ctx: PolicyContext): PolicyResult {
  const violations: string[] = [];
  const ports: DeclaredPort[] = [];
  const reject = (message: string) => violations.push(message);
  const proxyNames = new Set([ctx.proxyNetwork, DEFAULT_PROXY_NETWORK]);
  const checkFile = (where: string, path: string) => {
    if (!isLocalPath(path) || !ctx.isInsideCheckout(resolve(path))) {
      reject(`${where}: "${path}" is outside the repository`);
    }
  };

  for (const [name, service] of Object.entries(config.services)) {
    const at = `service "${name}"`;
    if (service.privileged) reject(`${at}: privileged is not allowed`);
    const networkMode = service.network_mode;
    if (networkMode && networkMode !== 'none' && !isOwnService(networkMode, config.services)) {
      reject(`${at}: network_mode ${networkMode} is not allowed (use none or service:<name>)`);
    }
    for (const key of ['pid', 'ipc', 'uts', 'userns_mode', 'cgroup'] as const) {
      const mode = service[key];
      if (mode && !PRIVATE_NAMESPACE_MODES.includes(mode) && !isOwnService(mode, config.services)) {
        reject(`${at}: ${key} ${mode} is not allowed`);
      }
    }
    for (const cap of service.cap_add ?? []) {
      if (!ALLOWED_CAPABILITIES.includes(normalizeCapability(cap))) {
        reject(
          `${at}: cap_add ${cap} is not allowed (allowed: ${ALLOWED_CAPABILITIES.join(', ')})`,
        );
      }
    }
    for (const option of service.security_opt ?? []) {
      if (!isAllowedSecurityOpt(option)) {
        reject(`${at}: security_opt ${option} is not allowed (only no-new-privileges)`);
      }
    }
    if (service.devices && service.devices.length > 0) reject(`${at}: devices are not allowed`);
    if (service.device_cgroup_rules && service.device_cgroup_rules.length > 0) {
      reject(`${at}: device_cgroup_rules are not allowed`);
    }
    if (service.cgroup_parent) reject(`${at}: cgroup_parent is not allowed`);
    if (service.runtime) reject(`${at}: a custom runtime is not allowed`);
    if (service.gpus !== undefined && service.gpus !== null) reject(`${at}: gpus are not allowed`);
    const reservedDevices = service.deploy?.resources?.reservations?.devices;
    if (reservedDevices && reservedDevices.length > 0) {
      reject(`${at}: device reservations are not allowed`);
    }
    for (const from of service.volumes_from ?? []) {
      if (from.startsWith('container:')) reject(`${at}: volumes_from ${from} is not allowed`);
    }
    if (service.use_api_socket) reject(`${at}: use_api_socket is not allowed`);
    if (service.provider !== undefined && service.provider !== null) {
      reject(`${at}: provider services are not allowed`);
    }
    if (service.container_name && RESERVED_SERVICE_NAMES.includes(service.container_name)) {
      reject(`${at}: container_name "${service.container_name}" is reserved`);
    }
    for (const volume of service.volumes ?? []) {
      if (!MOUNT_TYPES_ALLOWED.includes(volume.type)) {
        reject(
          volume.type === 'bind'
            ? `${at}: host bind mount "${volume.source ?? ''}" is not allowed (use a named volume)`
            : `${at}: mount type ${volume.type} is not allowed`,
        );
      }
    }
    for (const network of Object.keys(service.networks ?? {})) {
      if (proxyNames.has(network)) reject(`${at}: must not join the proxy network "${network}"`);
    }
    for (const file of service.env_file ?? []) {
      checkFile(`${at} env_file`, typeof file === 'string' ? file : file.path);
    }
    for (const file of service.label_file ?? []) checkFile(`${at} label_file`, file);
    const build = service.build;
    if (build) {
      const context = build.context ?? '.';
      const contextIsLocal = isLocalPath(context);
      if (contextIsLocal) checkFile(`${at} build context`, context);
      if (contextIsLocal && build.dockerfile) {
        const dockerfile = resolve(context, build.dockerfile);
        checkFile(`${at} dockerfile`, dockerfile);
      }
      const extra = build.additional_contexts;
      const extraValues = Array.isArray(extra)
        ? extra.map((entry) => entry.slice(entry.indexOf('=') + 1))
        : Object.values(extra ?? {});
      for (const value of extraValues) {
        if (isLocalPath(value)) checkFile(`${at} additional_contexts`, value);
        else if (/^oci-layout:/i.test(value)) {
          reject(`${at}: additional_contexts "${value}" is not allowed`);
        }
      }
      if (build.network === 'host') reject(`${at}: build network host is not allowed`);
      if (build.privileged) reject(`${at}: privileged builds are not allowed`);
      if (build.entitlements && build.entitlements.length > 0) {
        reject(`${at}: build entitlements are not allowed`);
      }
    }
    for (const port of service.ports ?? []) {
      ports.push({
        service: name,
        containerPort: String(port.target),
        hostPort:
          port.published === undefined || port.published === null ? null : String(port.published),
        hostIp: port.host_ip ?? null,
        protocol: port.protocol ?? 'tcp',
      });
    }
  }

  for (const [key, volume] of Object.entries(config.volumes ?? {})) {
    const at = `volume "${key}"`;
    if (volume && isExternal(volume.external)) reject(`${at}: external volumes are not allowed`);
    const name = volume?.name ?? `${ctx.projectName}_${key}`;
    if (!name.startsWith(`${ctx.projectName}_`)) {
      reject(`${at}: custom volume name "${name}" is not allowed`);
    }
    const driver = volume?.driver;
    if (driver && driver !== 'local') reject(`${at}: volume driver "${driver}" is not allowed`);
    const opts = volume?.driver_opts;
    if (opts && Object.keys(opts).length > 0) {
      const type = String(opts.type ?? '');
      const o = String(opts.o ?? '');
      const device = String(opts.device ?? '');
      const unknownOpts = Object.keys(opts).filter((opt) => !['type', 'o', 'device'].includes(opt));
      // Network shares (`:/export`, `//server/share`) and tmpfs only; never a host path.
      const hostPath =
        type === 'cifs' || type === 'smb3' ? !device.startsWith('//') : device.startsWith('/');
      if (
        !VOLUME_TYPES_ALLOWED.includes(type) ||
        unknownOpts.length > 0 ||
        hostPath ||
        /(^|,)(r?bind|lowerdir|upperdir|workdir)(=|,|$)/.test(o)
      ) {
        reject(
          `${at}: volumes backed by host paths are not allowed (driver_opts: nfs, cifs or tmpfs only)`,
        );
      }
    }
  }

  for (const [key, network] of Object.entries(config.networks ?? {})) {
    const at = `network "${key}"`;
    const name = network?.name ?? `${ctx.projectName}_${key}`;
    if (proxyNames.has(key) || proxyNames.has(name)) {
      reject(`${at}: the proxy network is attached by Launchway; do not declare it`);
    } else if (network && isExternal(network.external)) {
      reject(`${at}: external networks are not allowed`);
    } else if (!name.startsWith(`${ctx.projectName}_`)) {
      reject(`${at}: custom network name "${name}" is not allowed`);
    }
    if (name === 'host' || network?.driver === 'host') {
      reject(`${at}: host networking is not allowed`);
    } else if (network?.driver && network.driver !== 'bridge') {
      reject(`${at}: network driver "${network.driver}" is not allowed`);
    }
    if (network?.driver_opts && Object.keys(network.driver_opts).length > 0) {
      reject(`${at}: network driver_opts are not allowed`);
    }
  }

  for (const kind of ['configs', 'secrets'] as const) {
    for (const [key, entry] of Object.entries(config[kind] ?? {})) {
      const at = `${kind.slice(0, -1)} "${key}"`;
      if (entry?.file) checkFile(at, entry.file);
      if (entry && isExternal(entry.external)) reject(`${at}: external ${kind} are not allowed`);
    }
  }

  for (const route of ctx.routes) {
    const service = config.services[route.service];
    const at = `route to "${route.service}"`;
    if (RESERVED_SERVICE_NAMES.includes(route.service)) {
      reject(`${at}: the service name is reserved for platform containers`);
    }
    if (!service) {
      reject(`${at}: the service does not exist in the Compose project`);
    } else if (service.network_mode) {
      reject(`${at}: a routed service cannot use network_mode`);
    }
  }

  return { violations, ports };
}
