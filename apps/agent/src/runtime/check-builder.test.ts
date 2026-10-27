import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BuilderContext,
  CHECK_BUILD_CACHE_MB,
  CHECK_BUILDER_IMAGE,
  CHECK_BUILDER_NETWORK,
  CHECK_BUILDER_SETTINGS,
  CHECK_BUILDKITD_CONFIG,
  CHECK_BUILDKITD_FLAGS,
  CheckBuilderError,
  cacheMountPruneArgs,
  checkBuilderContainer,
  checkBuilderCreateArgs,
  checkBuilderName,
  checkBuilderPruneArgs,
  ensureCheckBuilder,
  pruneCheckBuilder,
  removeIdleCheckBuilders,
} from './check-builder.js';
import type { RunOptions, RunResult } from './exec.js';

const logger = pino({ level: 'silent' });
const LIMITS = { memoryBytes: 2048 * 1024 ** 2, cpus: 2, pidsLimit: 4096 };
const NAME = checkBuilderName(LIMITS);
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const USES_FILE = 'launchway-check-builders.json';
const CONFIG_FILE = 'launchway-check-buildkitd.toml';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'launchway-check-builder-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok = (stdout = ''): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  aborted: false,
  timedOut: false,
});
const failed =
  (line = 'error'): ((options: RunOptions) => RunResult) =>
  (options) => {
    options.onStderrLine?.(line);
    return { ...ok(), code: 1 };
  };

type Answer = ((options: RunOptions, args: string[]) => RunResult) | string;

/** A scripted docker: answers by the first words of the arguments (`buildx inspect`). */
function fakeDocker(answers: Record<string, Answer> = {}) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const ctx: BuilderContext = {
    run: async (_command, args, options = {}) => {
      calls.push({ args: [...args], env: options.env });
      const answer = answers[args.slice(0, 2).join(' ')] ?? answers[args[0] ?? ''];
      if (typeof answer === 'function') return answer(options, [...args]);
      return ok(answer ?? '');
    },
    env: { BUILDX_CONFIG: dir },
    buildxDir: dir,
    cwd: '/ws/agent/compose-cwd',
    logger,
    now: () => NOW,
  };
  return {
    ctx,
    calls,
    keys: () => calls.map((call) => call.args.slice(0, 2).join(' ')),
    removals: () =>
      calls
        .filter((call) => call.args.includes('rm'))
        .map((call) =>
          call.args.slice(0, call.args[0] === 'rm' ? 1 : 2).concat(call.args.at(-1) ?? ''),
        ),
  };
}

const uses = async (): Promise<unknown> => JSON.parse(await readFile(join(dir, USES_FILE), 'utf8'));
const containers = (...names: string[]) => names.map(checkBuilderContainer).join('\n');

describe('check builder options', () => {
  it('names builders after their limits and a hash of everything they are made of', () => {
    expect(NAME).toMatch(/^launchway-check-build-2048m-2c-[0-9a-f]{8}$/);
    expect(checkBuilderName({ memoryBytes: 512 * 1024 ** 2, cpus: 1.25 })).toMatch(
      /^launchway-check-build-512m-1\.25c-[0-9a-f]{8}$/,
    );
    expect(checkBuilderName({ ...LIMITS })).toBe(NAME);
    // Another image, network, flag or configuration line makes another builder: buildx never
    // changes an existing one.
    const others = [
      checkBuilderName(LIMITS, {
        ...CHECK_BUILDER_SETTINGS,
        image: `moby/buildkit:v0.34.0@sha256:${'f'.repeat(64)}`,
      }),
      checkBuilderName(LIMITS, { ...CHECK_BUILDER_SETTINGS, network: 'another-network' }),
      checkBuilderName(LIMITS, {
        ...CHECK_BUILDER_SETTINGS,
        buildkitdFlags: CHECK_BUILDKITD_FLAGS.replace('5000', '6000'),
      }),
      checkBuilderName(LIMITS, {
        ...CHECK_BUILDER_SETTINGS,
        buildkitdConfig: `${CHECK_BUILDKITD_CONFIG}\n[log]\n  format = "json"\n`,
      }),
      // The same MiB in the name, other bytes in the hash.
      checkBuilderName({ ...LIMITS, memoryBytes: LIMITS.memoryBytes + 1 }),
      checkBuilderName({ ...LIMITS, cpus: 2.5 }),
    ];
    expect(new Set([NAME, ...others]).size).toBe(others.length + 1);
    // The process limit is applied with `docker update`: no new builder for it.
    const fewerProcesses = { ...LIMITS, pidsLimit: 64 };
    expect(checkBuilderName(fewerProcesses)).toBe(NAME);
    expect(checkBuilderContainer(NAME)).toBe(`buildx_buildkit_${NAME}0`);
  });

  it('creates a docker-container builder with the check limits, network, bounded cache and configuration', () => {
    const limits = { memoryBytes: 1024 ** 3, cpus: 1.5 };
    expect(checkBuilderCreateArgs(limits, '/ws/agent/buildx/buildkitd.toml')).toEqual([
      'buildx',
      'create',
      '--name',
      checkBuilderName(limits),
      '--driver',
      'docker-container',
      '--driver-opt',
      `image=${CHECK_BUILDER_IMAGE}`,
      '--driver-opt',
      `network=${CHECK_BUILDER_NETWORK}`,
      '--driver-opt',
      `memory=${1024 ** 3}`,
      '--driver-opt',
      `memory-swap=${1024 ** 3}`,
      '--driver-opt',
      'cpu-period=100000',
      '--driver-opt',
      'cpu-quota=150000',
      '--buildkitd-flags',
      `--oci-worker-gc --oci-worker-gc-keepstorage=1000,0,${CHECK_BUILD_CACHE_MB} --oci-worker-net=host`,
      '--buildkitd-config',
      '/ws/agent/buildx/buildkitd.toml',
      '--bootstrap',
    ]);
    expect(CHECK_BUILDER_IMAGE).toMatch(/^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    // Docker's embedded DNS for build steps; `# syntax=` only for Docker's Dockerfile frontend.
    expect(CHECK_BUILDKITD_CONFIG).toContain('[dns]\n  nameservers = ["127.0.0.11"]\n');
    expect(CHECK_BUILDKITD_CONFIG).toContain(
      '[frontend."gateway.v0"]\n  enabled = true\n  allowedRepositories = ["docker.io/docker/dockerfile"]\n',
    );
  });

  it('pins the same image as the Dockerfile Dependabot updates', async () => {
    const dockerfile = await readFile(
      new URL('../../check-builder.Dockerfile', import.meta.url),
      'utf8',
    );
    const from = dockerfile.split('\n').filter((line) => /^FROM\s/i.test(line));
    expect(from).toEqual([`FROM ${CHECK_BUILDER_IMAGE}`]);
  });

  it('prunes the cache mounts, then the cache to its bound', () => {
    expect(checkBuilderPruneArgs('b')).toEqual([
      ['buildx', 'prune', '--builder', 'b', '--force', '--filter', 'type=exec.cachemount'],
      [
        'buildx',
        'prune',
        '--builder',
        'b',
        '--force',
        '--max-used-space',
        `${CHECK_BUILD_CACHE_MB}MB`,
      ],
    ]);
    expect(cacheMountPruneArgs('b')).toEqual(checkBuilderPruneArgs('b')[0]);
  });
});

describe('ensureCheckBuilder', () => {
  it('boots a known builder, limits its processes and empties its cache mounts', async () => {
    const docker = fakeDocker({ 'ps --all': containers(NAME) });
    expect(await ensureCheckBuilder(docker.ctx, LIMITS)).toBe(NAME);
    expect(docker.keys()).toEqual([
      'network inspect',
      'buildx inspect',
      'update --pids-limit',
      'buildx prune',
      'ps --all',
    ]);
    expect(docker.calls[1]?.args).toEqual(['buildx', 'inspect', '--bootstrap', '--', NAME]);
    expect(docker.calls[2]?.args).toEqual([
      'update',
      '--pids-limit',
      '4096',
      '--',
      checkBuilderContainer(NAME),
    ]);
    expect(docker.calls[3]?.args).toEqual(cacheMountPruneArgs(NAME));
    // Every command sees the agent's own buildx records.
    expect(docker.calls.every((call) => call.env?.BUILDX_CONFIG === dir)).toBe(true);
    expect(await uses()).toEqual({ [NAME]: NOW });
    expect((await stat(join(dir, USES_FILE))).mode & 0o777).toBe(0o600);
  });

  it('creates the network and the builder when they do not exist', async () => {
    let networks = 0;
    const docker = fakeDocker({
      'network inspect': (options) => (networks++ === 0 ? failed()(options) : ok()),
      'buildx inspect': failed(`ERROR: no builder "${NAME}" found`),
    });
    await ensureCheckBuilder(docker.ctx, LIMITS);
    expect(docker.keys()).toEqual([
      'network inspect',
      'network create',
      'buildx inspect',
      'buildx create',
      'update --pids-limit',
      'buildx prune',
      'ps --all',
    ]);
    expect(docker.calls[1]?.args).toEqual([
      'network',
      'create',
      '--driver',
      'bridge',
      '--label',
      'launchway.check.builder=true',
      '--',
      CHECK_BUILDER_NETWORK,
    ]);
    expect(docker.calls[3]?.args).toEqual(checkBuilderCreateArgs(LIMITS, join(dir, CONFIG_FILE)));
    expect(await readFile(join(dir, CONFIG_FILE), 'utf8')).toBe(CHECK_BUILDKITD_CONFIG);
  });

  it('replaces a builder that does not start, such as one whose first start failed', async () => {
    const pullError = 'ERROR: Error response from daemon: failed to resolve reference: not found';
    const docker = fakeDocker({ 'buildx inspect': failed(pullError) });
    const lines: string[] = [];
    await ensureCheckBuilder({ ...docker.ctx, onLine: (line) => lines.push(line) }, LIMITS);
    // `buildx create` of an existing record would only answer "existing instance".
    expect(docker.keys().slice(1, 4)).toEqual(['buildx inspect', 'buildx rm', 'buildx create']);
    expect(docker.calls[2]?.args).toEqual(['buildx', 'rm', '--force', '--', NAME]);
    expect(lines[0]).toBe(`the check builder ${NAME} does not start (${pullError}); replacing it`);
  });

  it('removes check builders of other limits or settings, also forgotten ones, and nothing else', async () => {
    const other = 'launchway-check-build-4096m-2c-0123abcd';
    // Named by an agent from before names had a hash; buildx no longer knows it.
    const forgotten = 'launchway-check-build-1024m-1c';
    await writeFile(join(dir, USES_FILE), JSON.stringify({ [other]: NOW - HOUR }));
    const docker = fakeDocker({
      'ps --all': [
        checkBuilderContainer(NAME),
        checkBuilderContainer(other),
        checkBuilderContainer(forgotten),
        'buildx_buildkit_launchway-check-build-x',
        'buildx_buildkit_other0',
        'zeus-builder',
      ].join('\n'),
      'buildx rm': (options, args) =>
        args.at(-1) === other ? ok() : failed('ERROR: no builder found')(options),
    });
    await ensureCheckBuilder(docker.ctx, LIMITS);
    expect(docker.removals()).toEqual([
      ['buildx', 'rm', other],
      ['buildx', 'rm', forgotten],
      ['rm', checkBuilderContainer(forgotten)],
      ['volume', 'rm', `${checkBuilderContainer(forgotten)}_state`],
    ]);
    const ps = docker.calls.find((call) => call.args[0] === 'ps');
    expect(ps?.args).toContain('name=^buildx_buildkit_launchway-check-build-');
    expect(await uses()).toEqual({ [NAME]: NOW });
  });

  it('fails with what Docker said when the builder cannot be created, limited or emptied', async () => {
    const create = fakeDocker({
      'buildx inspect': failed(`ERROR: no builder "${NAME}" found`),
      'buildx create': failed('ERROR: failed to pull moby/buildkit'),
    });
    const error = await ensureCheckBuilder(create.ctx, LIMITS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckBuilderError);
    expect((error as CheckBuilderError).message).toBe(`Could not create the check builder ${NAME}`);
    expect((error as CheckBuilderError).output).toEqual([
      `ERROR: no builder "${NAME}" found`,
      'ERROR: failed to pull moby/buildkit',
    ]);

    const update = fakeDocker({ update: failed('Error: no such container') });
    await expect(ensureCheckBuilder(update.ctx, LIMITS)).rejects.toThrow(
      `Could not limit the processes of the check builder ${NAME}`,
    );
    const prune = fakeDocker({ 'buildx prune': failed('ERROR: no builder found') });
    await expect(ensureCheckBuilder(prune.ctx, LIMITS)).rejects.toThrow(
      `Could not empty the cache mounts of the check builder ${NAME}`,
    );
  });
});

describe('removeIdleCheckBuilders', () => {
  const idle = 'launchway-check-build-1024m-1c-89abcdef';
  const unknown = 'launchway-check-build-512m-1c-01234567';

  it('removes builders unused for a day and builders the agent does not know', async () => {
    await writeFile(
      join(dir, USES_FILE),
      JSON.stringify({ [NAME]: NOW - HOUR, [idle]: NOW - 25 * HOUR, gone: NOW }),
    );
    const docker = fakeDocker({ 'ps --all': containers(NAME, idle, unknown) });
    expect(await removeIdleCheckBuilders(docker.ctx)).toEqual([idle, unknown]);
    expect(docker.removals()).toEqual([
      ['buildx', 'rm', idle],
      ['buildx', 'rm', unknown],
    ]);
    expect(await uses()).toEqual({ [NAME]: NOW - HOUR });
  });

  it('removes the builder network once no builder is left', async () => {
    await writeFile(join(dir, USES_FILE), JSON.stringify({ [idle]: NOW - 48 * HOUR }));
    const docker = fakeDocker({ 'ps --all': containers(idle) });
    expect(await removeIdleCheckBuilders(docker.ctx)).toEqual([idle]);
    expect(docker.calls.at(-1)?.args).toEqual(['network', 'rm', '--', CHECK_BUILDER_NETWORK]);
    expect(await uses()).toEqual({});
  });

  it('leaves everything alone when Docker cannot list the builders', async () => {
    const docker = fakeDocker({ 'ps --all': failed('Cannot connect to the Docker daemon') });
    expect(await removeIdleCheckBuilders(docker.ctx)).toEqual([]);
    expect(docker.keys()).toEqual(['ps --all']);
  });
});

describe('pruneCheckBuilder', () => {
  it('prunes without failing the run', async () => {
    const docker = fakeDocker({ 'buildx prune': failed() });
    await expect(pruneCheckBuilder(docker.ctx, NAME)).resolves.toBeUndefined();
    expect(docker.calls.map((call) => call.args)).toEqual(checkBuilderPruneArgs(NAME));
  });
});
