import { posix, resolve } from 'node:path';
import {
  DEFAULT_PROXY_NETWORK,
  type DeployAttach,
  type DeployPolicy,
  type DeployRoute,
  isCheckImageReference,
  RESERVED_SERVICE_NAMES,
} from '@launchway/contracts';
import { z } from 'zod';
import { CHECK_BUILDER_CONTAINER_PREFIX } from './check-builder.js';

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
/**
 * Host paths a trusted bind mount may not reach, unless it lies below an allowed root that is
 * itself deeper than the protected path (Docker Desktop shares host drives below
 * `/run/desktop/mnt/host`). `/` itself is always refused.
 */
export const PROTECTED_HOST_PATHS: readonly string[] = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/var/run',
  '/run',
];
/** Host paths no bind mount may reach, whatever the allowed roots (Docker's own data). */
const FORBIDDEN_HOST_PATHS: readonly string[] = ['/var/lib/docker'];
/** Bind propagation modes that would leak mounts between the container and the host. */
const PROPAGATION_REFUSED = ['shared', 'rshared', 'slave', 'rslave'];
/**
 * Volumes of the platform itself, never reused by apps: those of its Compose projects and the
 * state (BuildKit cache) of check builders.
 */
const PLATFORM_VOLUME_PREFIXES = ['launchway_', 'launchway-agent_', CHECK_BUILDER_CONTAINER_PREFIX];

/**
 * Largest file a check passes inline (`configs: { content }`); bind-mounted files above it come
 * from the source volume, configs and secrets above it are refused.
 */
export const MAX_INLINE_FILE_BYTES = 64 * 1024;
/** Keys of the volumes and configs the check document adds; a project may not declare them. */
export const CHECK_KEY_PREFIX = 'launchway-check-';

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
  image: z.string().nullish(),
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
  // Read leniently: their shape is only checked in check mode.
  configs: z.unknown().optional(),
  secrets: z.unknown().optional(),
  models: z.unknown().optional(),
  post_start: z.unknown().optional(),
  pre_stop: z.unknown().optional(),
  volumes: z
    .array(
      z.looseObject({
        type: z.string(),
        source: z.string().nullish(),
        bind: z.looseObject({ propagation: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
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
      ssh: z.unknown().optional(),
      tags: z.array(z.string()).nullish(),
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
  .looseObject({
    file: z.string().nullish(),
    external: z.unknown().optional(),
    environment: z.unknown().optional(),
  })
  .nullable();

/** The parts of `docker compose config --format json --no-env-resolution` the policy reads. */
export const ComposeConfig = z.looseObject({
  services: z.record(z.string(), Service),
  volumes: z.record(z.string(), Volume).nullish(),
  networks: z.record(z.string(), Network).nullish(),
  configs: z.record(z.string(), FileObject).nullish(),
  secrets: z.record(z.string(), FileObject).nullish(),
  models: z.unknown().optional(),
});
export type ComposeConfig = z.infer<typeof ComposeConfig>;

export interface PolicyContext {
  /** `launchway-<slug>`; project-owned volumes are named `<project>_<key>`. */
  projectName: string;
  proxyNetwork: string;
  routes: readonly DeployRoute[];
  /** Services attached to the proxy network without a route; checked like routed services. */
  attach?: readonly DeployAttach[];
  /** True when an absolute path lies inside the checkout (symlinks resolved). */
  isInsideCheckout: (path: string) => boolean;
  /** Compose project directory; relative bind sources are resolved against it. */
  projectDir: string;
  /** The agent workspace (LAUNCHWAY_WORKSPACE); never bind-mountable. */
  workspaceRoot: string;
  /**
   * The deployment's mount policy (`DeployPayload.policy`). Missing or `trustedMounts: false`
   * means untrusted: no bind mounts, external volumes or custom volume names.
   */
  mountPolicy?: DeployPolicy | undefined;
  /**
   * `check` (ADR 0020): a check run. Always untrusted (`mountPolicy` is ignored) and without
   * routes; binds of paths inside the checkout are allowed (the check document turns them into
   * volume mounts), `ports` and `container_name` are allowed (they are removed), Docker Model
   * Runner models and privileged lifecycle hooks are refused, and the configs and secrets the
   * services use must be files of at most MAX_INLINE_FILE_BYTES.
   */
  mode?: 'deploy' | 'check';
  /** Check mode: the size of the regular file at an absolute path (symlinks followed), or null. */
  fileSize?: (path: string) => number | null;
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
  /** Mounts allowed only because the app is trusted (reported in the deployment log). */
  trustedMounts: string[];
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

/** True when `child` is `root` or below it; both absolute POSIX paths. */
function isWithinPosix(root: string, child: string): boolean {
  const rel = posix.relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel));
}

/**
 * Why a trusted app may not bind-mount `source` (a daemon-side path; relative sources resolve
 * against the project directory), or null when it lies below one of the allowed roots.
 */
function trustedBindRefusal(
  source: string,
  ctx: PolicyContext,
  roots: readonly string[],
): string | null {
  const resolved = posix.resolve(ctx.projectDir, source);
  if (source.includes('docker.sock') || resolved.includes('docker.sock')) {
    return 'the Docker socket can never be mounted';
  }
  if (resolved === '/') return 'the host root directory can never be mounted';
  if (isWithinPosix(posix.resolve(ctx.workspaceRoot), resolved)) {
    return 'it lies inside the agent workspace';
  }
  const forbidden = FORBIDDEN_HOST_PATHS.find((path) => isWithinPosix(path, resolved));
  if (forbidden) return `${forbidden} can never be mounted`;
  const root = roots.find((candidate) => isWithinPosix(candidate, resolved));
  if (!root) return 'it is outside the allowed bind-mount roots of this node';
  const protectedPath = PROTECTED_HOST_PATHS.find((path) => isWithinPosix(path, resolved));
  if (protectedPath && !(root !== protectedPath && isWithinPosix(protectedPath, root))) {
    return `it lies below the protected path ${protectedPath}`;
  }
  return null;
}

function normalizeCapability(cap: string): string {
  return cap.toUpperCase().replace(/^CAP_/, '');
}

/**
 * `docker compose config` doubles every `$` of its output (the file is interpolated again when it
 * is loaded), paths included; `a$$b` names the file `a$b`.
 */
export function unescapeInterpolation(value: string): string {
  return value.replaceAll('$$', () => '$');
}

/** The local path a path of the Compose output names (relative ones resolve against `base`). */
export function localPath(base: string, value: string): string {
  return resolve(base, unescapeInterpolation(value));
}

const hasEntries = (value: unknown) =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === 'object' && value !== null && Object.keys(value).length > 0;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `[id, path]` of the `build.ssh` entries that name key files (`id=path[,path]`). */
function sshKeyPaths(value: unknown): [string, string][] {
  const found: [string, string][] = [];
  const add = (id: unknown, paths: unknown) => {
    if (typeof paths !== 'string') return;
    for (const path of paths.split(',')) if (path.trim()) found.push([String(id), path.trim()]);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const eq = entry.indexOf('=');
        if (eq >= 0) add(entry.slice(0, eq), entry.slice(eq + 1));
      } else if (typeof entry === 'object' && entry !== null) {
        const key = entry as Record<string, unknown>;
        add(key.id ?? key.ID ?? '', key.path ?? key.Path);
      }
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [id, paths] of Object.entries(value)) add(id, paths);
  }
  return found;
}

/**
 * Ids of `build.ssh` entries without a key path (`default`, `github`, and `github=`, as Compose
 * may render a bare id): they forward the SSH agent of the process that builds, which builds on
 * Launchway nodes do not have, so such builds could only fail late.
 */
function sshAgentForwards(value: unknown): string[] {
  const found: string[] = [];
  const add = (id: unknown, paths: unknown) => {
    const named = typeof paths === 'string' && paths.split(',').some((path) => path.trim());
    if (!named) found.push(String(id ?? ''));
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const eq = entry.indexOf('=');
        add(eq < 0 ? entry : entry.slice(0, eq), eq < 0 ? undefined : entry.slice(eq + 1));
      } else if (typeof entry === 'object' && entry !== null) {
        const key = entry as Record<string, unknown>;
        add(key.id ?? key.ID, key.path ?? key.Path);
      }
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [id, paths] of Object.entries(value)) add(id, paths);
  }
  return found;
}

/** Names of the top-level configs or secrets that services (not builds) mount. */
function usedByServices(config: ComposeConfig, kind: 'configs' | 'secrets'): Set<string> {
  const used = new Set<string>();
  for (const service of Object.values(config.services)) {
    for (const entry of asArray(service[kind])) {
      if (typeof entry === 'string') used.add(entry);
      else if (typeof entry === 'object' && entry !== null) {
        const source = (entry as { source?: unknown }).source;
        if (typeof source === 'string') used.add(source);
      }
    }
  }
  return used;
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
 *
 * Trusted apps (`mountPolicy.trustedMounts`, an admin decision; ADR 0015) may also bind-mount
 * paths below the node's allowed roots and use external volumes and custom volume names. The
 * Docker socket, `/`, protected system paths, Docker's data, the agent workspace, mount
 * propagation and the platform's own volumes stay refused.
 *
 * Check runs use `mode: 'check'` (see PolicyContext.mode).
 */
export function evaluateComposePolicy(config: ComposeConfig, ctx: PolicyContext): PolicyResult {
  const violations: string[] = [];
  const ports: DeclaredPort[] = [];
  const trustedMounts: string[] = [];
  const reject = (message: string) => violations.push(message);
  const check = ctx.mode === 'check';
  const trusted = !check && ctx.mountPolicy?.trustedMounts === true;
  const roots = trusted ? (ctx.mountPolicy?.allowedBindRoots ?? []).map(posix.normalize) : [];
  const rootList = `allowed roots: ${roots.length > 0 ? roots.join(', ') : 'none configured on this node'}`;
  const proxyNames = new Set([ctx.proxyNetwork, DEFAULT_PROXY_NETWORK]);
  const isInside = (path: string) => ctx.isInsideCheckout(localPath(ctx.projectDir, path));
  const checkFile = (where: string, path: string) => {
    if (!isLocalPath(path) || !isInside(path)) {
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
    // `launchway-check/` holds the images checks build: a deployment that ran or tagged one could
    // run whatever a branch's check built. Checks retag their built services into it themselves.
    const image = service.image ? unescapeInterpolation(service.image) : '';
    if (isCheckImageReference(image) && (!check || !service.build)) {
      reject(
        `${at}: image "${image}" is in the launchway-check/ namespace, which belongs to checks`,
      );
    }
    for (const tag of check ? [] : (service.build?.tags ?? [])) {
      if (isCheckImageReference(unescapeInterpolation(tag))) {
        reject(
          `${at}: build tag "${unescapeInterpolation(tag)}" is in the launchway-check/ namespace, which belongs to checks`,
        );
      }
    }
    if (service.provider !== undefined && service.provider !== null) {
      reject(`${at}: provider services are not allowed`);
    }
    if (
      !check &&
      service.container_name &&
      RESERVED_SERVICE_NAMES.includes(service.container_name)
    ) {
      reject(`${at}: container_name "${service.container_name}" is reserved`);
    }
    if (check && hasEntries(service.models)) {
      reject(`${at}: models (Docker Model Runner) are not allowed in checks`);
    }
    // A privileged exec gets every capability inside the container.
    for (const hook of [...asArray(service.post_start), ...asArray(service.pre_stop)]) {
      if ((hook as { privileged?: unknown } | null)?.privileged === true) {
        reject(`${at}: privileged lifecycle hooks (post_start, pre_stop) are not allowed`);
      }
    }
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && check) {
        const source = volume.source ?? '';
        if (!source || !isInside(source)) {
          reject(
            `${at}: bind mount "${source}" is not allowed: checks only bind-mount paths inside the repository`,
          );
        }
        continue;
      }
      // An image mount reads any image of the node, such as another app's.
      if (volume.type === 'image' && check) {
        reject(`${at}: image mounts are not allowed in checks (use a volume or tmpfs)`);
        continue;
      }
      if (volume.type === 'bind' && trusted) {
        const source = volume.source ?? '';
        const resolved = posix.resolve(ctx.projectDir, source);
        const shown = resolved === source ? `"${source}"` : `"${source}" (resolved "${resolved}")`;
        const refusal = source ? trustedBindRefusal(source, ctx, roots) : 'it has no source';
        const propagation = volume.bind?.propagation;
        if (refusal) {
          reject(`${at}: bind mount ${shown} is not allowed: ${refusal} (${rootList})`);
        } else if (propagation && PROPAGATION_REFUSED.includes(propagation)) {
          reject(
            `${at}: bind mount ${shown} uses propagation ${propagation}, which is not allowed`,
          );
        } else {
          trustedMounts.push(`service ${name} bind-mounts ${resolved}`);
        }
        continue;
      }
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
        else if (check) {
          // docker-image://, service:, target:, URLs: a check builds from the repository only.
          reject(
            `${at}: additional_contexts "${value}" is not allowed in checks (only directories of the repository)`,
          );
        } else if (/^oci-layout:/i.test(value)) {
          reject(`${at}: additional_contexts "${value}" is not allowed`);
        }
      }
      for (const [id, path] of sshKeyPaths(build.ssh)) {
        if (path.startsWith('~') || !isInside(path)) {
          reject(`${at}: build ssh key "${id}" (${path}) is outside the repository`);
        }
      }
      for (const id of sshAgentForwards(build.ssh)) {
        reject(
          `${at}: build ssh "${id}" forwards an SSH agent, which builds on Launchway nodes do not have`,
        );
      }
      if (build.network === 'host') reject(`${at}: build network host is not allowed`);
      if (build.privileged) reject(`${at}: privileged builds are not allowed`);
      if (build.entitlements && build.entitlements.length > 0) {
        reject(`${at}: build entitlements are not allowed`);
      }
    }
    // Checks remove published ports; deployments report them.
    for (const port of check ? [] : (service.ports ?? [])) {
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
    const external = volume !== null && isExternal(volume.external);
    if (trusted) {
      const name = volume?.name ?? (external ? key : `${ctx.projectName}_${key}`);
      const own = name.startsWith(`${ctx.projectName}_`);
      if (!own && PLATFORM_VOLUME_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        reject(`${at}: volume "${name}" belongs to the Launchway platform and is never allowed`);
      } else if (external || !own) {
        trustedMounts.push(`volume ${key} uses ${external ? 'external ' : ''}volume ${name}`);
      }
    } else {
      if (external) reject(`${at}: external volumes are not allowed`);
      const name = volume?.name ?? `${ctx.projectName}_${key}`;
      if (!name.startsWith(`${ctx.projectName}_`)) {
        reject(`${at}: custom volume name "${name}" is not allowed`);
      }
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
    const inlined = check ? usedByServices(config, kind) : new Set<string>();
    for (const [key, entry] of Object.entries(config[kind] ?? {})) {
      const at = `${kind.slice(0, -1)} "${key}"`;
      if (entry?.file) checkFile(at, entry.file);
      if (entry && isExternal(entry.external)) reject(`${at}: external ${kind} are not allowed`);
      if (check && key.startsWith(CHECK_KEY_PREFIX)) {
        reject(`${at}: names starting with "${CHECK_KEY_PREFIX}" are reserved for Launchway`);
      }
      // The Compose CLI's own environment is no source for a check.
      if (check && entry && entry.environment !== undefined && entry.environment !== null) {
        reject(`${at}: ${kind} from the environment are not allowed in checks`);
      }
      // Checks pass the files that services mount inline (bind mounts do not reach the agent).
      if (
        check &&
        entry?.file &&
        inlined.has(key) &&
        isLocalPath(entry.file) &&
        isInside(entry.file)
      ) {
        const size = ctx.fileSize?.(localPath(ctx.projectDir, entry.file)) ?? null;
        if (size === null) reject(`${at}: "${entry.file}" is not a file in the repository`);
        else if (size > MAX_INLINE_FILE_BYTES) {
          reject(
            `${at}: "${entry.file}" is larger than ${MAX_INLINE_FILE_BYTES / 1024} KiB, the most a check passes to a service`,
          );
        }
      }
    }
  }

  if (check) {
    if (hasEntries(config.models)) reject('models (Docker Model Runner) are not allowed in checks');
    for (const key of Object.keys(config.volumes ?? {})) {
      if (key.startsWith(CHECK_KEY_PREFIX)) {
        reject(
          `volume "${key}": names starting with "${CHECK_KEY_PREFIX}" are reserved for Launchway`,
        );
      }
    }
    // References too, declared or not: the check document declares such keys itself.
    for (const [name, service] of Object.entries(config.services)) {
      const referenced = [
        ...(service.volumes ?? []).flatMap((volume) =>
          volume.type === 'volume' && typeof volume.source === 'string' ? [volume.source] : [],
        ),
        ...[...asArray(service.configs), ...asArray(service.secrets)].flatMap((entry) => {
          if (typeof entry === 'string') return [entry];
          const source = (entry as { source?: unknown } | null)?.source;
          return typeof source === 'string' ? [source] : [];
        }),
      ];
      for (const key of new Set(referenced)) {
        if (key.startsWith(CHECK_KEY_PREFIX)) {
          reject(
            `service "${name}": "${key}" is reserved for Launchway (names starting with "${CHECK_KEY_PREFIX}")`,
          );
        }
      }
    }
  }

  const attached = [
    ...ctx.routes.map((route) => ({ service: route.service, at: `route to "${route.service}"` })),
    ...(ctx.attach ?? []).map((entry) => ({
      service: entry.service,
      at: `attached service "${entry.service}"`,
    })),
  ];
  for (const route of attached) {
    const service = config.services[route.service];
    const at = route.at;
    if (RESERVED_SERVICE_NAMES.includes(route.service)) {
      reject(`${at}: the service name is reserved for platform containers`);
    }
    if (!service) {
      reject(`${at}: the service does not exist in the Compose project`);
    } else if (service.network_mode) {
      reject(`${at}: a service on the proxy network cannot use network_mode`);
    }
  }

  return { violations, ports, trustedMounts };
}
