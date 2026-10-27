import type { CheckLimits } from '@launchway/contracts';
import type { Logger } from 'pino';
import type { Runner, RunResult } from './exec.js';
import { Tail } from './lines.js';

/**
 * BuildKit of the check builder, pinned: buildx's default for `docker-container` builders
 * (`moby/buildkit:buildx-stable-1`) when it was chosen. Update it with BuildKit releases.
 */
export const CHECK_BUILDER_IMAGE =
  'moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea';
/**
 * Bridge network of the check builder. Build steps reach the internet through it, but no other
 * container of the node: user-defined bridges are isolated from each other and from the default
 * bridge.
 */
export const CHECK_BUILDER_NETWORK = 'launchway-check-build';
/** Label of the builder network (the builder container itself is created by buildx, unlabelled). */
export const CHECK_BUILDER_LABEL = 'launchway.check.builder';
/** Check builders are named after their limits: other limits make another builder. */
export const CHECK_BUILDER_PREFIX = 'launchway-check-build-';
/**
 * Build cache a check builder keeps, in MB: BuildKit collects garbage beyond it while it builds,
 * and every run prunes to it afterwards.
 */
export const CHECK_BUILD_CACHE_MB = 5000;
/** Space BuildKit's garbage collection always leaves to the cache, in MB. */
const CHECK_BUILD_CACHE_RESERVED_MB = 1000;
const CPU_PERIOD = 100_000;
const BUILDER_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 2 * 60_000;

type BuilderLimits = Pick<CheckLimits, 'memoryBytes' | 'cpus'>;

/** `launchway-check-build-2048m-2c`, `launchway-check-build-512m-1.25c`. */
export function checkBuilderName(limits: BuilderLimits): string {
  const mib = Math.round(limits.memoryBytes / (1024 * 1024));
  return `${CHECK_BUILDER_PREFIX}${mib}m-${String(limits.cpus)}c`;
}

/** Container buildx runs the builder's BuildKit in (its first and only node). */
export function checkBuilderContainer(name: string): string {
  return `buildx_buildkit_${name}0`;
}

/**
 * `docker buildx create` arguments of a check builder: a `docker-container` builder (its own
 * BuildKit, cache and cache mounts, apart from the engine's builder that deployments use) with
 * the memory (no swap) and CPU limits of a check service, on its own network, with a bounded
 * cache. BuildKit runs privileged in that container, as with every `docker-container` builder;
 * build steps stay in its sandbox.
 */
export function checkBuilderCreateArgs(
  name: string,
  limits: BuilderLimits,
  image = CHECK_BUILDER_IMAGE,
): string[] {
  return [
    'buildx',
    'create',
    '--name',
    name,
    '--driver',
    'docker-container',
    '--driver-opt',
    `image=${image}`,
    '--driver-opt',
    `network=${CHECK_BUILDER_NETWORK}`,
    '--driver-opt',
    `memory=${limits.memoryBytes}`,
    '--driver-opt',
    `memory-swap=${limits.memoryBytes}`,
    '--driver-opt',
    `cpu-period=${CPU_PERIOD}`,
    '--driver-opt',
    `cpu-quota=${Math.round(limits.cpus * CPU_PERIOD)}`,
    '--buildkitd-flags',
    `--oci-worker-gc --oci-worker-gc-keepstorage=${CHECK_BUILD_CACHE_RESERVED_MB},0,${CHECK_BUILD_CACHE_MB}`,
    '--bootstrap',
  ];
}

/** `docker buildx prune` of a check builder down to CHECK_BUILD_CACHE_MB. */
export function checkBuilderPruneArgs(name: string): string[] {
  return [
    'buildx',
    'prune',
    '--builder',
    name,
    '--force',
    '--max-used-space',
    `${CHECK_BUILD_CACHE_MB}MB`,
  ];
}

export interface BuilderContext {
  run: Runner;
  /** Environment of the docker commands of checks (BUILDX_CONFIG set). */
  env: NodeJS.ProcessEnv;
  cwd: string;
  logger: Logger;
  signal?: AbortSignal;
  /** Output of the builder commands, for the run's log. */
  onLine?: (line: string) => void;
}

/** Thrown when the check builder cannot be prepared; the message ends with Docker's output. */
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

async function ensureNetwork(ctx: BuilderContext): Promise<void> {
  const inspect = () =>
    docker(ctx, ['network', 'inspect', '--format', '{{.Name}}', '--', CHECK_BUILDER_NETWORK]);
  if ((await inspect()).code === 0) return;
  const created = await docker(ctx, [
    'network',
    'create',
    '--driver',
    'bridge',
    '--label',
    `${CHECK_BUILDER_LABEL}=true`,
    '--',
    CHECK_BUILDER_NETWORK,
  ]);
  // Another agent on this daemon may have created it meanwhile.
  if (created.code !== 0 && (await inspect()).code !== 0) {
    throw new CheckBuilderError(
      'Could not create the network of the check builder',
      created.output,
    );
  }
}

/**
 * Removes check builders made for other limits, found by their BuildKit containers (the daemon
 * knows them even when buildx's records are gone with an old agent workspace): through buildx,
 * then by name, container and state volume. Only names with the check builder prefix are touched;
 * failures are logged and left alone. (`docker buildx ls` would ask every Docker context.)
 */
async function removeOtherBuilders(ctx: BuilderContext, current: string): Promise<void> {
  const prefix = `buildx_buildkit_${CHECK_BUILDER_PREFIX}`;
  const containers = await docker(ctx, [
    'ps',
    '--all',
    '--filter',
    `name=^${prefix}`,
    '--format',
    '{{.Names}}',
  ]);
  if (containers.code !== 0) return;
  for (const container of containers.stdout.split('\n').map((line) => line.trim())) {
    if (!container.startsWith(prefix) || !container.endsWith('0')) continue;
    if (container === checkBuilderContainer(current)) continue;
    const name = container.slice('buildx_buildkit_'.length, -1);
    const removed = await docker(ctx, ['buildx', 'rm', '--force', '--', name]);
    if (removed.code !== 0) {
      await docker(ctx, ['rm', '--force', '--', container]);
      await docker(ctx, ['volume', 'rm', '--force', '--', `${container}_state`]);
    }
    ctx.logger.info({ builder: name }, 'removed a check builder of other limits');
  }
}

/**
 * Makes sure the check builder for `limits` exists and runs, with the process limit applied to
 * its container, and removes builders of other limits. Returns its name for `--builder`.
 */
export async function ensureCheckBuilder(
  ctx: BuilderContext,
  limits: CheckLimits,
  image = CHECK_BUILDER_IMAGE,
): Promise<string> {
  const name = checkBuilderName(limits);
  await ensureNetwork(ctx);
  // Boots a known builder (and recreates its container if it went away).
  const known = await docker(
    ctx,
    ['buildx', 'inspect', '--bootstrap', '--', name],
    BUILDER_TIMEOUT_MS,
  );
  if (known.code !== 0) {
    ctx.onLine?.(`creating the check builder ${name}`);
    const created = await docker(
      ctx,
      checkBuilderCreateArgs(name, limits, image),
      BUILDER_TIMEOUT_MS,
      true,
    );
    if (created.code !== 0) {
      throw new CheckBuilderError(`Could not create the check builder ${name}`, created.output);
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
  await removeOtherBuilders(ctx, name);
  return name;
}

/** Prunes a check builder's cache down to CHECK_BUILD_CACHE_MB; failures are only logged. */
export async function pruneCheckBuilder(ctx: BuilderContext, name: string): Promise<void> {
  const pruned = await docker(ctx, checkBuilderPruneArgs(name));
  if (pruned.code !== 0) {
    ctx.logger.warn({ builder: name, output: pruned.output }, 'could not prune the check builder');
  }
}
