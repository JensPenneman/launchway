import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckLimits } from '@launchway/contracts';
import type { Logger } from 'pino';
import type { Runner, RunResult } from './exec.js';
import { Tail } from './lines.js';
import { writeFileReplacing } from './workspace.js';

/**
 * BuildKit of the check builder, pinned: buildx's default for `docker-container` builders
 * (`moby/buildkit:buildx-stable-1`) when it was chosen. `apps/agent/check-builder.Dockerfile`
 * carries the same reference for Dependabot; a test keeps both equal.
 */
export const CHECK_BUILDER_IMAGE =
  'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea';
/**
 * Bridge network of the check builder. Build steps cannot reach the addresses of containers on
 * other networks (the default bridge included), but they can reach ports the node publishes,
 * through any bridge gateway, like every container.
 */
export const CHECK_BUILDER_NETWORK = 'launchway-check-build';
/** Label of the builder network (the builder container itself is created by buildx, unlabelled). */
export const CHECK_BUILDER_LABEL = 'launchway.check.builder';
/** Check builders are named after their limits and settings: other ones make another builder. */
export const CHECK_BUILDER_PREFIX = 'launchway-check-build-';
/** Containers (`<prefix><name>0`) and state volumes (`…0_state`) of check builders. */
export const CHECK_BUILDER_CONTAINER_PREFIX = `buildx_buildkit_${CHECK_BUILDER_PREFIX}`;
/**
 * Build cache a check builder keeps, in MB: BuildKit collects garbage beyond it while it builds,
 * and every run prunes to it afterwards. One build can still write more until it ends.
 */
export const CHECK_BUILD_CACHE_MB = 5000;
/** A check builder unused this long is removed (with its cache): checks may have been turned off. */
export const CHECK_BUILDER_IDLE_MS = 24 * 60 * 60_000;
/**
 * buildkitd.toml of check builders. Build steps share the builder container's network namespace
 * (`--oci-worker-net=host`) so that they resolve names through Docker's embedded DNS, like every
 * container (BuildKit would hand them 8.8.8.8 otherwise); `# syntax=` may only name Docker's own
 * Dockerfile frontend.
 */
export const CHECK_BUILDKITD_CONFIG = `# Written by the Launchway agent: the BuildKit configuration of check builders.
[dns]
  nameservers = ["127.0.0.11"]

[frontend."gateway.v0"]
  enabled = true
  allowedRepositories = ["docker.io/docker/dockerfile"]
`;
/** Space BuildKit's garbage collection always leaves to the cache, in MB. */
const CHECK_BUILD_CACHE_RESERVED_MB = 1000;
/** buildkitd flags of check builders: a bounded cache, and build steps on the builder's network. */
export const CHECK_BUILDKITD_FLAGS = `--oci-worker-gc --oci-worker-gc-keepstorage=${CHECK_BUILD_CACHE_RESERVED_MB},0,${CHECK_BUILD_CACHE_MB} --oci-worker-net=host`;

/** What a check builder is made of, apart from the check limits; the defaults below. */
export interface BuilderSettings {
  image: string;
  network: string;
  buildkitdFlags: string;
  buildkitdConfig: string;
}

export const CHECK_BUILDER_SETTINGS: BuilderSettings = {
  image: CHECK_BUILDER_IMAGE,
  network: CHECK_BUILDER_NETWORK,
  buildkitdFlags: CHECK_BUILDKITD_FLAGS,
  buildkitdConfig: CHECK_BUILDKITD_CONFIG,
};

const CPU_PERIOD = 100_000;
const BUILDER_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 2 * 60_000;
/** Builders of this agent and when it last used them, next to buildx's records. */
const USES_FILE = 'launchway-check-builders.json';
const CONFIG_FILE = 'launchway-check-buildkitd.toml';

type BuilderLimits = Pick<CheckLimits, 'memoryBytes' | 'cpus'>;

/** Everything a check builder is created with, but its name and the path of its configuration. */
function createOptions(limits: BuilderLimits, settings: BuilderSettings): string[] {
  return [
    '--driver',
    'docker-container',
    '--driver-opt',
    `image=${settings.image}`,
    '--driver-opt',
    `network=${settings.network}`,
    '--driver-opt',
    `memory=${limits.memoryBytes}`,
    '--driver-opt',
    `memory-swap=${limits.memoryBytes}`,
    '--driver-opt',
    `cpu-period=${CPU_PERIOD}`,
    '--driver-opt',
    `cpu-quota=${Math.round(limits.cpus * CPU_PERIOD)}`,
    '--buildkitd-flags',
    settings.buildkitdFlags,
  ];
}

/**
 * `launchway-check-build-2048m-2c-<8 hex>`: the limits to read, and a hash of every create option
 * and of the BuildKit configuration, so a new image or setting makes a new builder (an existing
 * builder is never changed in place; buildx would even adopt its container unchanged).
 */
export function checkBuilderName(
  limits: BuilderLimits,
  settings: BuilderSettings = CHECK_BUILDER_SETTINGS,
): string {
  const mib = Math.round(limits.memoryBytes / (1024 * 1024));
  const hash = createHash('sha256')
    .update(JSON.stringify([createOptions(limits, settings), settings.buildkitdConfig]))
    .digest('hex')
    .slice(0, 8);
  return `${CHECK_BUILDER_PREFIX}${mib}m-${String(limits.cpus)}c-${hash}`;
}

/** Container buildx runs the builder's BuildKit in (its first and only node). */
export function checkBuilderContainer(name: string): string {
  return `buildx_buildkit_${name}0`;
}

/**
 * `docker buildx create` arguments of a check builder: a `docker-container` builder (its own
 * BuildKit and cache, apart from the engine's builder that deployments use) with the memory (no
 * swap) and CPU limits of a check service, on its own network, with a bounded cache and the
 * configuration CHECK_BUILDKITD_CONFIG. BuildKit runs privileged in that container, as with every
 * `docker-container` builder; build steps stay in its sandbox.
 */
export function checkBuilderCreateArgs(
  limits: BuilderLimits,
  configPath: string,
  settings: BuilderSettings = CHECK_BUILDER_SETTINGS,
): string[] {
  return [
    'buildx',
    'create',
    '--name',
    checkBuilderName(limits, settings),
    ...createOptions(limits, settings),
    '--buildkitd-config',
    configPath,
    '--bootstrap',
  ];
}

/**
 * Empties the cache mounts (`RUN --mount=type=cache`) of a builder. Every build of the builder
 * shares them, whatever the app, so they are emptied before every build and after every run:
 * nothing one repository writes there reaches the build of another.
 */
export function cacheMountPruneArgs(name: string): string[] {
  return ['buildx', 'prune', '--builder', name, '--force', '--filter', 'type=exec.cachemount'];
}

/** `docker buildx prune` calls after a run: the cache mounts, then the cache to its bound. */
export function checkBuilderPruneArgs(name: string): string[][] {
  return [
    cacheMountPruneArgs(name),
    [
      'buildx',
      'prune',
      '--builder',
      name,
      '--force',
      '--max-used-space',
      `${CHECK_BUILD_CACHE_MB}MB`,
    ],
  ];
}

export interface BuilderContext {
  run: Runner;
  /** Environment of the docker commands of checks (BUILDX_CONFIG set to `buildxDir`). */
  env: NodeJS.ProcessEnv;
  /** The agent's buildx records (BUILDX_CONFIG), where the builder bookkeeping lives too. */
  buildxDir: string;
  cwd: string;
  logger: Logger;
  signal?: AbortSignal;
  /** Output of the builder commands, for the run's log. */
  onLine?: (line: string) => void;
  now?: () => number;
}

/** Thrown when the check builder cannot be prepared; `output` holds Docker's last lines. */
export class CheckBuilderError extends Error {
  readonly output: readonly string[];
  constructor(message: string, output: readonly string[]) {
    super(message);
    this.name = 'CheckBuilderError';
    this.output = output;
  }
}

async function docker(
  ctx: BuilderContext,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
  echo = false,
): Promise<RunResult & { output: string[] }> {
  const output = new Tail<string>(20);
  const onLine = (line: string) => {
    output.push(line);
    if (echo) ctx.onLine?.(line);
  };
  const result = await ctx.run('docker', args, {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    captureStdoutBytes: 1024 * 1024,
    onStderrLine: onLine,
  });
  return { ...result, output: output.values() };
}

async function ensureNetwork(ctx: BuilderContext, network: string): Promise<void> {
  const inspect = () => docker(ctx, ['network', 'inspect', '--format', '{{.Name}}', '--', network]);
  if ((await inspect()).code === 0) return;
  const created = await docker(ctx, [
    'network',
    'create',
    '--driver',
    'bridge',
    '--label',
    `${CHECK_BUILDER_LABEL}=true`,
    '--',
    network,
  ]);
  // Another agent on this daemon may have created it meanwhile.
  if (created.code !== 0 && (await inspect()).code !== 0) {
    throw new CheckBuilderError(
      'Could not create the network of the check builder',
      created.output,
    );
  }
}

/** When this agent last used each of its check builders (epoch ms), from its bookkeeping file. */
async function readUses(ctx: BuilderContext): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(ctx.buildxDir, USES_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}

async function writeUses(ctx: BuilderContext, uses: Record<string, number>): Promise<void> {
  await writeFileReplacing(join(ctx.buildxDir, USES_FILE), `${JSON.stringify(uses)}\n`, 0o600);
}

/** Names of the check builders the daemon has containers of (`docker ps`, never `buildx ls`). */
async function builderNames(ctx: BuilderContext): Promise<string[] | null> {
  const listed = await docker(ctx, [
    'ps',
    '--all',
    '--filter',
    `name=^${CHECK_BUILDER_CONTAINER_PREFIX}`,
    '--format',
    '{{.Names}}',
  ]);
  if (listed.code !== 0) return null;
  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.startsWith(CHECK_BUILDER_CONTAINER_PREFIX) && name.endsWith('0'))
    .map((container) => container.slice('buildx_buildkit_'.length, -1));
}

/** Removes one check builder: through buildx, else by container and state volume. */
async function removeBuilder(ctx: BuilderContext, name: string): Promise<void> {
  const removed = await docker(ctx, ['buildx', 'rm', '--force', '--', name]);
  if (removed.code !== 0) {
    const container = checkBuilderContainer(name);
    await docker(ctx, ['rm', '--force', '--', container]);
    await docker(ctx, ['volume', 'rm', '--force', '--', `${container}_state`]);
  }
  ctx.logger.info({ builder: name }, 'removed a check builder');
}

/**
 * Makes sure the check builder for `limits` exists and runs, with the process limit applied to
 * its container and its cache mounts empty; removes check builders of other limits or settings
 * (one agent per Docker daemon: another agent's builders would go too, a build of theirs with
 * them). Returns its name for `--builder`.
 */
export async function ensureCheckBuilder(
  ctx: BuilderContext,
  limits: CheckLimits,
  settings: BuilderSettings = CHECK_BUILDER_SETTINGS,
): Promise<string> {
  const name = checkBuilderName(limits, settings);
  await ensureNetwork(ctx, settings.network);
  // Boots a known builder (and recreates its container if it went away).
  const known = await docker(
    ctx,
    ['buildx', 'inspect', '--bootstrap', '--', name],
    BUILDER_TIMEOUT_MS,
  );
  if (known.code !== 0) {
    if (!known.output.some((line) => /no builder .*found/i.test(line))) {
      // A record that cannot start (its first bootstrap failed, say): `buildx create` would only
      // answer "existing instance", so it is replaced.
      ctx.logger.warn(
        { builder: name, output: known.output },
        'replacing a check builder that does not start',
      );
      ctx.onLine?.(
        `the check builder ${name} does not start (${known.output.at(-1) ?? 'no output'}); replacing it`,
      );
      await docker(ctx, ['buildx', 'rm', '--force', '--', name]);
    }
    ctx.onLine?.(`creating the check builder ${name}`);
    const configPath = join(ctx.buildxDir, CONFIG_FILE);
    await writeFileReplacing(configPath, settings.buildkitdConfig, 0o600);
    const created = await docker(
      ctx,
      checkBuilderCreateArgs(limits, configPath, settings),
      BUILDER_TIMEOUT_MS,
      true,
    );
    if (created.code !== 0) {
      throw new CheckBuilderError(`Could not create the check builder ${name}`, [
        ...known.output,
        ...created.output,
      ]);
    }
  }
  const updated = await docker(ctx, [
    'update',
    '--pids-limit',
    String(limits.pidsLimit),
    '--',
    checkBuilderContainer(name),
  ]);
  if (updated.code !== 0) {
    throw new CheckBuilderError(
      `Could not limit the processes of the check builder ${name}`,
      updated.output,
    );
  }
  // Also after an agent that stopped before its run could prune.
  const emptied = await docker(ctx, cacheMountPruneArgs(name));
  if (emptied.code !== 0) {
    throw new CheckBuilderError(
      `Could not empty the cache mounts of the check builder ${name}`,
      emptied.output,
    );
  }
  for (const other of (await builderNames(ctx)) ?? []) {
    if (other !== name) await removeBuilder(ctx, other);
  }
  // The builders of other limits are gone: the bookkeeping holds this one only.
  await writeUses(ctx, { [name]: (ctx.now ?? Date.now)() });
  return name;
}

/**
 * Removes the check builders this agent has not used for CHECK_BUILDER_IDLE_MS, and those it does
 * not know (left by an earlier agent workspace), then the builder network once none is left.
 * Called at start and hourly; failures are logged and left alone.
 */
export async function removeIdleCheckBuilders(
  ctx: BuilderContext,
  idleMs = CHECK_BUILDER_IDLE_MS,
): Promise<string[]> {
  const names = await builderNames(ctx);
  if (names === null) return [];
  const now = (ctx.now ?? Date.now)();
  const uses = await readUses(ctx);
  const removed: string[] = [];
  for (const name of names) {
    const used = uses[name];
    if (used !== undefined && now - used < idleMs) continue;
    await removeBuilder(ctx, name);
    removed.push(name);
  }
  const kept = Object.fromEntries(
    Object.entries(uses).filter(([name]) => names.includes(name) && !removed.includes(name)),
  );
  if (Object.keys(kept).length !== Object.keys(uses).length) await writeUses(ctx, kept);
  if (names.length === removed.length) {
    const network = await docker(ctx, ['network', 'rm', '--', CHECK_BUILDER_NETWORK]);
    if (network.code === 0) ctx.logger.info('removed the network of the check builders');
  }
  return removed;
}

/** Prunes a check builder after a run (`checkBuilderPruneArgs`); failures are only logged. */
export async function pruneCheckBuilder(ctx: BuilderContext, name: string): Promise<void> {
  for (const args of checkBuilderPruneArgs(name)) {
    const pruned = await docker(ctx, args);
    if (pruned.code !== 0) {
      ctx.logger.warn(
        { builder: name, output: pruned.output },
        'could not prune the check builder',
      );
    }
  }
}
