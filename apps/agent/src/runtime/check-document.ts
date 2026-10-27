import {
  type CHECK_ENV_KEYS,
  CHECK_LABEL,
  type CheckLimits,
  type CheckRunPayload,
  checkImageName,
} from '@launchway/contracts';
import {
  CHECK_KEY_PREFIX,
  type ComposeConfig,
  localPath,
  unescapeInterpolation,
} from './compose-policy.js';
import { PolicyError } from './workspace.js';

/** Key of the source volume in the check document: the external volume `<project>_source`. */
export const SOURCE_VOLUME_KEY = `${CHECK_KEY_PREFIX}source`;

/**
 * Build arg every check build gets, over the project's own: the hostname of its RUN steps, which
 * BuildKit also keys their cache on (Dockerfile frontend 1.2 and later; a Dockerfile `ARG` cannot
 * change it). One per app, so a step one app's build ran is never reused by another app's build:
 * a step's cache key leaves out what its cache mounts and secrets held.
 */
export const BUILD_HOSTNAME_ARG = 'BUILDKIT_SANDBOX_HOSTNAME';

/** `check-<suffix of the app id>`: the hostname of an app's build steps. */
export function checkBuildHostname(appId: string): string {
  return `check-${appId.slice(appId.lastIndexOf('_') + 1)}`;
}

/**
 * What the agent found at a path inside the checkout, symlinks resolved. `relative` is the real
 * path relative to the checkout (`''` for the checkout itself, `/` separators); `content` is the
 * text of a file of at most MAX_INLINE_FILE_BYTES (absent for bigger and for binary files).
 */
export type SourcePath =
  | { kind: 'directory'; relative: string }
  | { kind: 'file'; relative: string; size: number; content?: string }
  | { kind: 'missing'; relative: string };

/** The only variables a check gets from Launchway (interpolation and its service's environment). */
export type CheckEnv = Readonly<Record<(typeof CHECK_ENV_KEYS)[number], string>>;

export function checkEnvironment(
  payload: Pick<CheckRunPayload, 'runId' | 'app' | 'source'>,
  project: string,
): CheckEnv {
  return {
    CI: 'true',
    COMPOSE_PROJECT_NAME: project,
    LAUNCHWAY_APP: payload.app.slug,
    LAUNCHWAY_CHECK: '1',
    LAUNCHWAY_CHECK_RUN_ID: payload.runId,
    LAUNCHWAY_COMMIT_SHA: payload.source.sha,
    LAUNCHWAY_REF: payload.source.ref,
  };
}

export interface CheckDocumentInput {
  /** `launchway-check_<slug>_<run id suffix>`. */
  project: string;
  appId: string;
  slug: string;
  runId: string;
  /** The service the check's command runs in. */
  service: string;
  env: CheckEnv;
  limits: CheckLimits;
  /** Compose project directory: relative paths of the output resolve against it. */
  projectDir: string;
  /** Facts about the paths `checkSourcePaths` returns; undefined outside the checkout. */
  sources: (path: string) => SourcePath | undefined;
}

export interface CheckDocument {
  /** The resolved Compose document every later command of the run uses (`-f compose.json`). */
  document: Record<string, unknown>;
  /** Image of the check's service (the source volume's helper containers run it too). */
  image: string;
  /** `user` of the check's service, if the project sets one. */
  user: string | null;
  /** True when a service mounts the source volume (so it must be created and filled). */
  usesSource: boolean;
  /** Missing bind sources (checkout-relative): created as directories before the copy. */
  directories: string[];
  /** What the rewrite did with the project's bind mounts, for the run's log. */
  notes: string[];
}

type Json = Record<string, unknown>;

/**
 * Service keys a check drops: published ports, fixed names, restarts, the logging driver (replaced
 * by CHECK_LOGGING), and every resource knob (replaced by the check limits).
 */
const REMOVED_SERVICE_KEYS = [
  'ports',
  'container_name',
  'deploy',
  'scale',
  'restart',
  'logging',
  'develop',
  'mem_limit',
  'mem_reservation',
  'memswap_limit',
  'cpus',
  'cpu_count',
  'cpu_percent',
  'cpu_quota',
  'cpu_period',
  'cpu_rt_runtime',
  'cpu_rt_period',
  'cpu_shares',
  'blkio_config',
  'cpuset',
  'storage_opt',
  'ulimits',
  'pids_limit',
  'oom_kill_disable',
  'oom_score_adj',
  // An image the repository names is pulled from its registry (`pull --policy always`), never
  // taken from the node: a local image may be another app's.
  'pull_policy',
] as const;

/** Check containers are the first ones the kernel kills when the node runs out of memory. */
const OOM_SCORE_ADJ = 1000;

/**
 * Logging of check containers: whatever the daemon's default driver is, a chatty check keeps at
 * most 30 MB of logs on the node (the run forwards at most CHECK_LOG_LINE_LIMIT lines anyway).
 */
const CHECK_LOGGING = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };

/**
 * Network keys a check drops: a repository-chosen subnet could overlap the node's or the Docker
 * VM's networks and change routing for every container while the run lasts, so check networks
 * take their addresses from the daemon's pools.
 */
const REMOVED_NETWORK_KEYS = ['ipam', 'enable_ipv4', 'enable_ipv6'] as const;
/** Fixed addresses need the subnet the check no longer chooses. */
const REMOVED_ATTACHMENT_KEYS = ['ipv4_address', 'ipv6_address', 'link_local_ips'] as const;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Text for the document: Compose interpolates it when loading, so `$` becomes `$$`. */
const escapeDollars = (value: string) => value.replaceAll('$', () => '$$');

/**
 * Entries without a value (`environment: [HTTPS_PROXY]`, `args: {X: null}`) are filled in from
 * the Compose CLI's environment when the container is created or the image built.
 */
function withValues(entries: Json): Json {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== null && value !== undefined),
  );
}

/** Labels or environment as a map (the output of `config` uses maps; lists are accepted too). */
function mapping(value: unknown): Json {
  if (!Array.isArray(value)) return isRecord(value) ? { ...value } : {};
  const out: Json = {};
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const eq = item.indexOf('=');
    if (eq < 0) out[item] = null;
    else out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/** The `source` a service's config or secret entry refers to (long or short syntax). */
function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  return isRecord(entry) && typeof entry.source === 'string' ? entry.source : undefined;
}

/** `cache_from` entries that read a directory of the agent (`type=local,src=...`). */
const isLocalCache = (entry: unknown) =>
  typeof entry === 'string' && entry.split(',').some((part) => part.trim() === 'type=local');

/** Where Compose mounts a service secret: below /run/secrets unless the target is absolute. */
function secretTarget(entry: unknown, source: string): string {
  const target = isRecord(entry) && typeof entry.target === 'string' ? entry.target : '';
  const name = target || source;
  return name.startsWith('/') ? name : `/run/secrets/${name}`;
}

const shown = (relative: string) => (relative ? `"${relative}"` : 'the repository');

/** Absolute local paths a check document needs facts about: bind sources, config/secret files. */
export function checkSourcePaths(config: ComposeConfig, projectDir: string): string[] {
  const paths = new Set<string>();
  for (const service of Object.values(config.services)) {
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && volume.source) paths.add(localPath(projectDir, volume.source));
    }
  }
  for (const kind of ['configs', 'secrets'] as const) {
    for (const entry of Object.values(config[kind] ?? {})) {
      if (entry?.file) paths.add(localPath(projectDir, entry.file));
    }
  }
  return [...paths];
}

/**
 * Rewrites the output of `docker compose config` (after the policy in check mode accepted it)
 * into the one document a check run uses (ADR 0020):
 *
 * - every service: labelled `launchway.check=<run id>`; no published ports, container_name,
 *   deploy, scale, restart policy, logging driver or develop section; its own resource settings
 *   replaced by the check limits (memory without swap, CPUs, processes, oom_score_adj 1000);
 *   no-new-privileges.
 * - built services: tagged `launchway-check/<slug>-<service>` (never an image of the project's
 *   choosing), no extra tags, no cache export, no local cache import, image label
 *   `launchway.check=<slug>`, never pulled.
 * - bind mounts (all inside the checkout): read-only binds of small text files become configs
 *   with inline content; directories (missing ones are created, as Docker would), writable,
 *   big and binary files become mounts of the source volume (`subpath` = their place in the
 *   repository). File-based configs and the secrets services use are inlined; secrets only builds
 *   use stay files (the CLI reads them).
 * - the source volume (external `<project>_source`); labels on the project's volumes and networks.
 * - the check's service gets the CHECK_ENV_KEYS variables, overriding its own.
 *
 * Strings of the output arrive escaped (`$$`) and are written back as they are.
 */
export function buildCheckDocument(
  config: ComposeConfig,
  input: CheckDocumentInput,
): CheckDocument {
  const doc = structuredClone(config) as Json;
  const services = (isRecord(doc.services) ? doc.services : {}) as Record<string, Json>;
  const own = services[input.service];
  if (!isRecord(own)) {
    throw new PolicyError(
      `The service "${input.service}" of the check does not exist in the Compose project`,
    );
  }
  const topConfigs: Json = isRecord(doc.configs) ? { ...doc.configs } : {};
  const topSecrets: Json = isRecord(doc.secrets) ? { ...doc.secrets } : {};
  const notes: string[] = [];
  const directories = new Set<string>();
  const inlined = new Map<string, string>();
  const convertedConfigs = new Set<string>();
  const buildSecrets = new Set<string>();
  let usesSource = false;

  const fileAt = (path: string, at: string) => {
    const source = input.sources(localPath(input.projectDir, path));
    if (source?.kind !== 'file') {
      throw new PolicyError(`${at}: "${path}" is not a file in the repository`);
    }
    if (source.content === undefined) {
      throw new PolicyError(
        `${at}: "${source.relative}" cannot be passed to a check (text files up to 64 KiB only)`,
      );
    }
    return { relative: source.relative, content: source.content };
  };
  /** Key of the top-level config that carries a repository file inline. */
  const inline = (file: { relative: string; content: string }) => {
    let key = inlined.get(file.relative);
    if (!key) {
      key = `${CHECK_KEY_PREFIX}file-${inlined.size + 1}`;
      inlined.set(file.relative, key);
      topConfigs[key] = { content: escapeDollars(file.content) };
    }
    return key;
  };

  for (const [name, service] of Object.entries(services)) {
    const at = `service "${name}"`;
    for (const key of REMOVED_SERVICE_KEYS) delete service[key];
    service.labels = { ...mapping(service.labels), [CHECK_LABEL]: input.runId };
    if (service.environment !== undefined) {
      const environment = withValues(mapping(service.environment));
      if (Object.keys(environment).length > 0) service.environment = environment;
      else delete service.environment;
    }
    service.mem_limit = input.limits.memoryBytes;
    service.memswap_limit = input.limits.memoryBytes;
    service.cpus = input.limits.cpus;
    service.pids_limit = input.limits.pidsLimit;
    service.oom_score_adj = OOM_SCORE_ADJ;
    service.logging = structuredClone(CHECK_LOGGING);
    if (isRecord(service.networks)) {
      const attachments: Json = {};
      for (const [network, attachment] of Object.entries(service.networks)) {
        const entry: Json | null = isRecord(attachment) ? { ...attachment } : null;
        if (entry) for (const key of REMOVED_ATTACHMENT_KEYS) delete entry[key];
        attachments[network] = entry && Object.keys(entry).length > 0 ? entry : null;
      }
      service.networks = attachments;
    }
    const securityOpt = Array.isArray(service.security_opt) ? service.security_opt : [];
    service.security_opt = [
      ...securityOpt.filter(
        (option) => typeof option === 'string' && !/^no-new-privileges\b/i.test(option),
      ),
      'no-new-privileges:true',
    ];

    if (isRecord(service.build)) {
      const build: Json = { ...service.build };
      delete build.tags;
      delete build.cache_to;
      if (Array.isArray(build.cache_from)) {
        const kept = build.cache_from.filter((entry) => !isLocalCache(entry));
        if (kept.length > 0) build.cache_from = kept;
        else delete build.cache_from;
      }
      build.labels = { ...mapping(build.labels), [CHECK_LABEL]: input.slug };
      build.args = {
        ...withValues(mapping(build.args)),
        [BUILD_HOSTNAME_ARG]: checkBuildHostname(input.appId),
      };
      for (const entry of Array.isArray(build.secrets) ? build.secrets : []) {
        const source = sourceOf(entry);
        if (source) buildSecrets.add(source);
      }
      service.build = build;
      service.image = checkImageName(input.slug, name);
      service.pull_policy = 'never';
    }

    const configs: unknown[] = Array.isArray(service.configs) ? [...service.configs] : [];
    for (const entry of configs) {
      const key = sourceOf(entry);
      const top = key === undefined ? undefined : topConfigs[key];
      if (key === undefined || convertedConfigs.has(key) || !isRecord(top)) continue;
      if (typeof top.file !== 'string') continue;
      const file = fileAt(top.file, `config "${key}"`);
      const converted: Json = { ...top, content: escapeDollars(file.content) };
      delete converted.file;
      topConfigs[key] = converted;
      convertedConfigs.add(key);
    }

    if (Array.isArray(service.volumes)) {
      const volumes: unknown[] = [];
      for (const volume of service.volumes) {
        if (!isRecord(volume) || volume.type !== 'bind') {
          volumes.push(volume);
          continue;
        }
        const raw = typeof volume.source === 'string' ? volume.source : '';
        const target = typeof volume.target === 'string' ? volume.target : '';
        const source = raw ? input.sources(localPath(input.projectDir, raw)) : undefined;
        if (!source) {
          throw new PolicyError(
            `${at}: bind mount "${raw}" is not a file or directory inside the repository`,
          );
        }
        const shownTarget = unescapeInterpolation(target);
        // A config is a read-only copy: writable file binds keep sharing the file through the volume.
        if (source.kind === 'file' && source.content !== undefined && volume.read_only === true) {
          configs.push({
            source: inline({ relative: source.relative, content: source.content }),
            target,
          });
          notes.push(`${at}: ${shown(source.relative)} is passed as a file at ${shownTarget}`);
          continue;
        }
        if (source.kind === 'missing') directories.add(source.relative);
        usesSource = true;
        volumes.push({
          type: 'volume',
          source: SOURCE_VOLUME_KEY,
          target,
          ...(volume.read_only === true ? { read_only: true } : {}),
          volume: {
            nocopy: true,
            ...(source.relative ? { subpath: escapeDollars(source.relative) } : {}),
          },
        });
        notes.push(
          `${at}: ${shown(source.relative)} is mounted from the source volume at ${shownTarget}${volume.read_only === true ? ' (read-only)' : ''}`,
        );
      }
      service.volumes = volumes;
    }

    if (Array.isArray(service.secrets)) {
      const kept: unknown[] = [];
      for (const entry of service.secrets) {
        const key = sourceOf(entry);
        const top = key === undefined ? undefined : topSecrets[key];
        if (key === undefined || !isRecord(top) || typeof top.file !== 'string') {
          kept.push(entry);
          continue;
        }
        const target = secretTarget(entry, key);
        configs.push({ source: inline(fileAt(top.file, `secret "${key}"`)), target });
        notes.push(
          `${at}: the secret ${key} is passed as a file at ${unescapeInterpolation(target)}`,
        );
      }
      if (kept.length > 0) service.secrets = kept;
      else delete service.secrets;
    }
    if (configs.length > 0) service.configs = configs;
  }

  // Services got their file-based secrets as configs; builds keep reading theirs from the checkout.
  for (const [key, top] of Object.entries(topSecrets)) {
    if (isRecord(top) && typeof top.file === 'string' && !buildSecrets.has(key)) {
      delete topSecrets[key];
    }
  }
  if (Object.keys(topConfigs).length > 0) doc.configs = topConfigs;
  else delete doc.configs;
  if (Object.keys(topSecrets).length > 0) doc.secrets = topSecrets;
  else delete doc.secrets;

  const labelled = (entries: unknown): Json => {
    const out: Json = {};
    for (const [key, value] of Object.entries(isRecord(entries) ? entries : {})) {
      const entry: Json = isRecord(value) ? { ...value } : {};
      entry.labels = { ...mapping(entry.labels), [CHECK_LABEL]: input.runId };
      out[key] = entry;
    }
    return out;
  };
  const volumes = labelled(doc.volumes);
  if (usesSource) volumes[SOURCE_VOLUME_KEY] = { name: `${input.project}_source`, external: true };
  if (Object.keys(volumes).length > 0) doc.volumes = volumes;
  else delete doc.volumes;
  const networks = labelled(doc.networks);
  for (const network of Object.values(networks)) {
    if (isRecord(network)) for (const key of REMOVED_NETWORK_KEYS) delete network[key];
  }
  if (Object.keys(networks).length > 0) doc.networks = networks;
  else delete doc.networks;

  own.environment = {
    ...mapping(own.environment),
    ...Object.fromEntries(
      Object.entries(input.env).map(([key, value]) => [key, escapeDollars(value)]),
    ),
  };
  doc.name = input.project;

  const image = typeof own.image === 'string' ? unescapeInterpolation(own.image) : '';
  if (!image) {
    throw new PolicyError(`The service "${input.service}" of the check has no image to run`);
  }
  const user = typeof own.user === 'string' ? unescapeInterpolation(own.user).trim() : '';
  return {
    document: doc,
    image,
    user: user || null,
    usesSource,
    directories: [...directories],
    notes,
  };
}
