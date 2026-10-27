import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  type BuilderContext,
  CHECK_BUILD_CACHE_MB,
  CHECK_BUILDER_IMAGE,
  CHECK_BUILDER_NETWORK,
  CheckBuilderError,
  checkBuilderContainer,
  checkBuilderCreateArgs,
  checkBuilderName,
  checkBuilderPruneArgs,
  ensureCheckBuilder,
  pruneCheckBuilder,
} from './check-builder.js';
import type { RunOptions, RunResult } from './exec.js';

const logger = pino({ level: 'silent' });
const LIMITS = { memoryBytes: 2048 * 1024 ** 2, cpus: 2, pidsLimit: 4096 };

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

/** A scripted docker: answers by the first words of the arguments (`buildx inspect`). */
function fakeDocker(answers: Record<string, ((options: RunOptions) => RunResult) | string> = {}) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const ctx: BuilderContext = {
    run: async (_command, args, options = {}) => {
      calls.push({ args: [...args], env: options.env });
      const key = args.slice(0, 2).join(' ');
      const answer = answers[key] ?? answers[args[0] ?? ''];
      if (typeof answer === 'function') return answer(options);
      return ok(answer ?? '');
    },
    env: { BUILDX_CONFIG: '/ws/agent/buildx' },
    cwd: '/ws/agent/compose-cwd',
    logger,
  };
  return { ctx, calls, keys: () => calls.map((call) => call.args.slice(0, 2).join(' ')) };
}

describe('check builder options', () => {
  it('names builders after their limits', () => {
    expect(checkBuilderName(LIMITS)).toBe('launchway-check-build-2048m-2c');
    expect(checkBuilderName({ memoryBytes: 512 * 1024 ** 2, cpus: 1.25 })).toBe(
      'launchway-check-build-512m-1.25c',
    );
    expect(checkBuilderContainer('launchway-check-build-2048m-2c')).toBe(
      'buildx_buildkit_launchway-check-build-2048m-2c0',
    );
  });

  it('creates a docker-container builder with the check limits, its own network and cache', () => {
    expect(checkBuilderCreateArgs('b', { memoryBytes: 1024 ** 3, cpus: 1.5 })).toEqual([
      'buildx',
      'create',
      '--name',
      'b',
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
      `--oci-worker-gc --oci-worker-gc-keepstorage=1000,0,${CHECK_BUILD_CACHE_MB}`,
      '--bootstrap',
    ]);
    expect(CHECK_BUILDER_IMAGE).toMatch(/^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it('prunes the cache to its bound', () => {
    expect(checkBuilderPruneArgs('b')).toEqual([
      'buildx',
      'prune',
      '--builder',
      'b',
      '--force',
      '--max-used-space',
      `${CHECK_BUILD_CACHE_MB}MB`,
    ]);
  });
});

describe('ensureCheckBuilder', () => {
  const name = 'launchway-check-build-2048m-2c';

  it('boots a known builder and limits its processes', async () => {
    const docker = fakeDocker();
    expect(await ensureCheckBuilder(docker.ctx, LIMITS)).toBe(name);
    expect(docker.keys()).toEqual([
      'network inspect',
      'buildx inspect',
      'update --pids-limit',
      'ps --all',
    ]);
    expect(docker.calls[1]?.args).toEqual(['buildx', 'inspect', '--bootstrap', '--', name]);
    expect(docker.calls[2]?.args).toEqual([
      'update',
      '--pids-limit',
      '4096',
      '--',
      checkBuilderContainer(name),
    ]);
    // Every command sees the agent's own buildx records.
    expect(docker.calls.every((call) => call.env?.BUILDX_CONFIG === '/ws/agent/buildx')).toBe(true);
  });

  it('creates the network and the builder when they do not exist', async () => {
    let networks = 0;
    const docker = fakeDocker({
      'network inspect': (options) => (networks++ === 0 ? failed()(options) : ok()),
      'buildx inspect': failed('ERROR: no builder found'),
    });
    await ensureCheckBuilder(docker.ctx, LIMITS);
    expect(docker.keys()).toEqual([
      'network inspect',
      'network create',
      'buildx inspect',
      'buildx create',
      'update --pids-limit',
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
    expect(docker.calls[3]?.args).toEqual(checkBuilderCreateArgs(name, LIMITS));
  });

  it('removes check builders of other limits, also forgotten ones, and nothing else', async () => {
    const docker = fakeDocker({
      'ps --all': [
        checkBuilderContainer(name),
        'buildx_buildkit_launchway-check-build-4096m-2c0',
        'buildx_buildkit_launchway-check-build-1024m-1c0',
        'buildx_buildkit_other0',
        'zeus-builder',
      ].join('\n'),
      // buildx knows the first, not the second (its records went with an old workspace).
      'buildx rm': (options) => {
        const known = docker.calls.at(-1)?.args.at(-1) === 'launchway-check-build-4096m-2c';
        return known ? ok() : failed('ERROR: no builder found')(options);
      },
    });
    await ensureCheckBuilder(docker.ctx, LIMITS);
    const removals = docker.calls
      .filter((call) => ['rm', 'volume', 'buildx'].includes(call.args[0] ?? ''))
      .filter((call) => call.args.includes('rm'))
      .map((call) => call.args.at(-1));
    expect(removals).toEqual([
      'launchway-check-build-4096m-2c',
      'launchway-check-build-1024m-1c',
      'buildx_buildkit_launchway-check-build-1024m-1c0',
      'buildx_buildkit_launchway-check-build-1024m-1c0_state',
    ]);
    const ps = docker.calls.find((call) => call.args[0] === 'ps');
    expect(ps?.args).toContain('name=^buildx_buildkit_launchway-check-build-');
  });

  it('fails with Docker output when the builder cannot be created or limited', async () => {
    const create = fakeDocker({
      'buildx inspect': failed(),
      'buildx create': failed('ERROR: failed to pull moby/buildkit'),
    });
    const error = await ensureCheckBuilder(create.ctx, LIMITS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckBuilderError);
    expect((error as CheckBuilderError).message).toBe(`Could not create the check builder ${name}`);
    expect((error as CheckBuilderError).output).toEqual(['ERROR: failed to pull moby/buildkit']);

    const update = fakeDocker({ update: failed('Error: no such container') });
    await expect(ensureCheckBuilder(update.ctx, LIMITS)).rejects.toThrow(
      `Could not limit the processes of the check builder ${name}`,
    );
  });

  it('prunes without failing the run', async () => {
    const docker = fakeDocker({ 'buildx prune': failed() });
    await expect(pruneCheckBuilder(docker.ctx, name)).resolves.toBeUndefined();
    expect(docker.calls[0]?.args).toEqual(checkBuilderPruneArgs(name));
  });
});
