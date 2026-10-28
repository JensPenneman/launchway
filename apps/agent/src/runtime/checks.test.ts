import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentToServerMessage,
  CHECK_LOG_LINE_LIMIT,
  type CheckResultPayload,
  type CheckRunPayload,
  checkImageName,
  checkProjectName,
  generateId,
  type LogLine,
} from '@launchway/contracts';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheMountPruneArgs, checkBuilderName, checkBuilderPruneArgs } from './check-builder.js';
import { CheckManager } from './checks.js';
import { Semaphore } from './deployments.js';
import type { Runner, RunOptions, RunResult } from './exec.js';
import { Workspace } from './workspace.js';

const logger = pino({ level: 'silent' });
const SHA = '3f786850e387550fdab836ed7e6dc881de23001b';
const TOKEN = 'ghs_supersecretchecktoken123';
const AUTH = `basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const COMPOSE_SUBCOMMANDS = ['config', 'build', 'pull', 'run', 'down'];

interface Call {
  command: string;
  args: string[];
  options: RunOptions;
}
type Handler = (call: Call) => Promise<Partial<RunResult>> | Partial<RunResult>;

const ok = (stdout = ''): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  aborted: false,
  timedOut: false,
});

/** `git fetch`, `compose build`, `docker volume create`, `docker cp`, ... */
function keyOf(command: string, args: readonly string[]): string {
  if (command === 'git') return `git ${args[0]}`;
  if (args[0] === 'compose') {
    return `compose ${args.find((arg, i) => i > 0 && COMPOSE_SUBCOMMANDS.includes(arg))}`;
  }
  const two = ['volume', 'container', 'image', 'network'].includes(args[0] ?? '');
  return `docker ${two ? `${args[0]} ${args[1]}` : args[0]}`;
}

/** A Trail-like project: a built dev service binding the repository, a db with an init file. */
const trailConfig = (dir: string, project = 'x') => ({
  name: project,
  services: {
    dev: {
      build: { context: dir, dockerfile: 'Dockerfile' },
      command: ['sleep', 'infinity'],
      volumes: [{ type: 'bind', source: dir, target: '/workspace', bind: {} }],
      depends_on: { db: { condition: 'service_healthy', required: true } },
      networks: { default: null },
    },
    db: {
      image: 'postgres:18-alpine',
      volumes: [
        {
          type: 'bind',
          source: `${dir}/config/init.sql`,
          target: '/docker-entrypoint-initdb.d/init.sql',
          read_only: true,
          bind: {},
        },
      ],
      networks: { default: null },
    },
  },
  networks: { default: { name: `${project}_default`, ipam: {} } },
});

interface Fake {
  run: Runner;
  calls: Call[];
  /** Calls and sent messages in order (`compose down`, `send check.result`). */
  events: string[];
  on: Partial<Record<string, Handler>>;
  config: (dir: string, project: string) => unknown;
  head: string;
  imageUser: string;
  exitCode: number;
  oomKilled: boolean;
  /** Content of the checkout's compose.yaml. */
  composeYaml: string;
}

function fakeDocker(): Fake {
  const fake: Fake = {
    calls: [],
    events: [],
    on: {},
    config: trailConfig,
    head: SHA,
    imageUser: 'tester',
    exitCode: 0,
    oomKilled: false,
    composeYaml: 'services: {}\n',
    run: async (command, args, options = {}) => {
      const call: Call = { command, args: [...args], options };
      const key = keyOf(command, args);
      fake.calls.push(call);
      fake.events.push(key);
      const handler = fake.on[key];
      if (handler) return { ...ok(), ...(await handler(call)) };
      switch (key) {
        case 'git init':
          await mkdir(args.at(-1) as string, { recursive: true });
          return ok();
        case 'git fetch':
          options.onStderrLine?.(`fatal: could not read from ${AUTH} (${TOKEN})`);
          return ok();
        case 'git checkout': {
          const dir = options.cwd as string;
          await writeFile(join(dir, 'compose.yaml'), fake.composeYaml);
          await mkdir(join(dir, 'config'), { recursive: true });
          await writeFile(join(dir, 'config', 'init.sql'), 'select 1; -- $HOME\n');
          return ok();
        }
        case 'git rev-parse':
          return ok(`${fake.head}\n`);
        case 'compose config': {
          const dir = args[args.indexOf('--project-directory') + 1] as string;
          const project = args[args.indexOf('-p') + 1] as string;
          return ok(JSON.stringify(fake.config(dir, project)));
        }
        case 'compose build':
          options.onStdoutLine?.('#1 building');
          return ok();
        case 'docker volume create':
          return ok(`${args.at(-1)}\n`);
        case 'docker container create':
          return ok('cid\n');
        case 'docker image inspect':
          return ok(`${fake.imageUser}\n`);
        case 'compose run':
          options.onStdoutLine?.('check output');
          options.onStderrLine?.('check warning');
          return { ...ok(), code: fake.exitCode };
        case 'docker container inspect':
          return ok(
            JSON.stringify({
              Status: 'exited',
              Running: false,
              OOMKilled: fake.oomKilled,
              ExitCode: fake.exitCode,
              StartedAt: '2026-10-27T10:00:00.000000000Z',
              Error: '',
            }),
          );
        default:
          return ok();
      }
    },
  };
  return fake;
}

/** Resolves when the call's abort signal fires, like a killed process. */
const blockUntilAborted = (call: Call): Promise<Partial<RunResult>> =>
  new Promise((resolve) => {
    call.options.signal?.addEventListener('abort', () => resolve({ code: null, aborted: true }), {
      once: true,
    });
  });

/** A handler that waits for `release()`. */
function gate(result: Partial<RunResult> = {}) {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const handler: Handler = async () => {
    entered += 1;
    await opened;
    return result;
  };
  return { handler, release: () => release(), entered: () => entered };
}

/** A `compose run` handler: every command waits for `release()`, or ends when aborted. */
function held() {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: Handler = (call) =>
    new Promise((resolve) => {
      call.options.signal?.addEventListener('abort', () => resolve({ code: null, aborted: true }), {
        once: true,
      });
      void opened.then(() => resolve({ code: 0 }));
    });
  return { handler, release: () => release() };
}

let root: string;
let messages: AgentToServerMessage[];
let fake: Fake;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'launchway-checks-'));
  messages = [];
  fake = fakeDocker();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NODE_CREDENTIAL = `lwya_${'n'.repeat(43)}`;

function manager(builds = new Semaphore(2)) {
  return new CheckManager({
    logger,
    send: (message) => {
      messages.push(message);
      fake.events.push(`send ${message.type}`);
    },
    workspace: new Workspace(root),
    builds,
    run: fake.run,
    env: { PATH: process.env.PATH ?? '' },
    secrets: () => [NODE_CREDENTIAL, null],
  });
}

const APP = { id: generateId('app'), slug: 'trail' };

function payload(overrides: Partial<CheckRunPayload> = {}): CheckRunPayload {
  return {
    runId: generateId('chk'),
    app: APP,
    source: {
      cloneUrl: 'https://github.com/acme/trail.git',
      ref: 'main',
      sha: SHA,
      authorization: AUTH,
    },
    composeFiles: ['compose.yaml'],
    check: {
      name: 'quality',
      service: 'dev',
      command: 'npm ci && npm run check',
      timeoutMs: 60_000,
    },
    limits: { memoryBytes: 1024 ** 3, cpus: 2, pidsLimit: 1024 },
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const results = () =>
  messages.flatMap((m) => (m.type === 'check.result' ? [{ id: m.id, ...m.payload }] : []));
const resultOf = (id: string): CheckResultPayload | undefined => {
  const found = messages.find((m) => m.id === id && m.type === 'check.result');
  return found?.type === 'check.result' ? found.payload : undefined;
};
const linesOf = (id: string): LogLine[] =>
  messages.flatMap((m) => (m.id === id && m.type === 'check.log' ? m.payload.lines : []));
const callsOf = (key: string) => fake.calls.filter((c) => keyOf(c.command, c.args) === key);
/** Resolves once a run has cleaned up (its directory is gone). */
const cleanedUp = async (run: CheckRunPayload) => {
  const dir = join(root, 'checks', run.app.id, run.runId);
  await waitFor(() => callsOf('compose down').length > 0 || results().length > 0);
  for (let i = 0; i < 400; i += 1) {
    if (
      !(await stat(dir).then(
        () => true,
        () => false,
      ))
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the run directory was not removed');
};

describe('CheckManager', () => {
  it('acknowledges at once, duplicates included, and runs a run once', async () => {
    const checks = manager();
    const run = payload();
    checks.run('req-1', run);
    checks.run('req-2', run);
    expect(messages.map((m) => [m.id, m.type])).toEqual([
      ['req-1', 'check.log'],
      ['req-2', 'check.log'],
    ]);
    expect(linesOf('req-1').map((l) => [l.seq, l.stream, l.line])).toEqual([
      [0, 'system', 'Received by the node'],
    ]);
    expect(linesOf('req-2').map((l) => [l.seq, l.line])).toEqual([
      [1, 'Already queued on this node'],
    ]);
    expect(checks.activeCheckRunIds()).toEqual([run.runId]);
    await waitFor(() => results().length === 1);
    expect(callsOf('git init')).toHaveLength(1);
  });

  it('runs a check end to end: fetch, config, policy, document, build, source, run, cleanup', async () => {
    const checks = manager();
    const run = payload();
    const project = checkProjectName('trail', run.runId);
    const image = checkImageName('trail', 'dev', run.runId);
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    await cleanedUp(run);

    expect(resultOf('req-1')).toEqual({ runId: run.runId, reason: 'exit', exitCode: 0 });
    expect(messages.every((m) => m.id === 'req-1')).toBe(true);
    expect(fake.events.filter((e) => !e.startsWith('send'))).toEqual([
      'git init',
      'git remote',
      'git fetch',
      'git checkout',
      'git rev-parse',
      'compose config',
      // The check builder: its network, booting it, its process limit, emptying its cache mounts,
      // builders of other limits or settings.
      'docker network inspect',
      'docker buildx',
      'docker update',
      'docker buildx',
      'docker ps',
      'compose build',
      'compose pull',
      'docker volume create',
      'docker container create',
      'docker cp',
      'docker rm',
      'docker image inspect',
      'docker run',
      'compose run',
      'docker container inspect',
      // Cleanup, after the result.
      'docker ps',
      'compose down',
      'docker volume rm',
      'docker volume ls',
      'docker network ls',
      'docker image rm',
      'docker image prune',
      // The check builder: its cache mounts emptied, its cache pruned to its bound.
      'docker buildx',
      'docker buildx',
    ]);
    // The result goes out before the cleanup starts.
    expect(fake.events.indexOf('send check.result')).toBeLessThan(
      fake.events.indexOf('compose down'),
    );
    const builder = checkBuilderName({ memoryBytes: 1024 * 1024 ** 2, cpus: 2 });
    expect(builder).toMatch(/^launchway-check-build-1024m-2c-[0-9a-f]{8}$/);
    const buildx = await import('node:fs').then((fs) => fs.realpathSync(root));
    expect(callsOf('compose build')[0]?.args.slice(-3)).toEqual(['--pull', '--builder', builder]);
    expect([root, buildx].map((r) => join(r, 'agent', 'buildx'))).toContain(
      callsOf('compose build')[0]?.options.env?.BUILDX_CONFIG,
    );
    expect(callsOf('docker update')[0]?.args).toEqual([
      'update',
      '--pids-limit',
      '1024',
      '--',
      `buildx_buildkit_${builder}0`,
    ]);
    expect(fake.calls.filter((c) => c.args[0] === 'buildx').map((c) => c.args)).toEqual([
      ['buildx', 'inspect', '--bootstrap', '--', builder],
      cacheMountPruneArgs(builder),
      ...checkBuilderPruneArgs(builder),
    ]);

    const dir = join(root, 'checks', APP.id, run.runId);
    const src = await import('node:fs').then((fs) => fs.realpathSync(root));
    const realDir = join(src, 'checks', APP.id, run.runId);
    const config = callsOf('compose config')[0];
    expect(config?.args).toEqual([
      'compose',
      '--ansi',
      'never',
      '--progress',
      'plain',
      '-p',
      project,
      '--project-directory',
      join(realDir, 'src'),
      '-f',
      join(realDir, 'src', 'compose.yaml'),
      '--env-file',
      join(dir, 'check.env'),
      'config',
      '--format',
      'json',
      '--no-env-resolution',
    ]);
    const composeRun = callsOf('compose run')[0];
    expect(composeRun?.args).toEqual([
      'compose',
      '--ansi',
      'never',
      '--progress',
      'plain',
      '-p',
      project,
      '-f',
      join(dir, 'compose.json'),
      '--env-file',
      join(dir, 'check.env'),
      'run',
      '-T',
      '--pull',
      'never',
      '--name',
      `${project}-check`,
      'dev',
      'sh',
      '-c',
      'npm ci && npm run check',
    ]);
    expect(callsOf('docker container create')[0]?.args).toEqual([
      'container',
      'create',
      '--pull',
      'never',
      '--name',
      `${project}-source`,
      '--label',
      `launchway.check=${run.runId}`,
      '--network',
      'none',
      '--entrypoint',
      'true',
      '--mount',
      `type=volume,src=${project}_source,dst=/src,volume-nocopy`,
      '--',
      image,
    ]);
    expect(callsOf('docker cp')[0]?.args).toEqual([
      'cp',
      `${join(realDir, 'src')}/.`,
      `${project}-source:/src`,
    ]);
    expect(callsOf('docker run')[0]?.args.slice(-7)).toEqual([
      '--',
      image,
      '-R',
      '-h',
      '--',
      'tester',
      '/src',
    ]);
    expect(callsOf('docker run')[0]?.args).toEqual(
      expect.arrayContaining(['--network', 'none', '--user', '0:0', '--cap-drop', 'ALL']),
    );
    expect(callsOf('compose down')[0]?.args).toEqual([
      'compose',
      '--ansi',
      'never',
      '--progress',
      'plain',
      '-p',
      project,
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '5',
    ]);
    expect(callsOf('docker volume rm')[0]?.args).toEqual([
      'volume',
      'rm',
      '--force',
      '--',
      `${project}_source`,
    ]);
    // The image the run built, by its tag of the run, then this app's dangling check images.
    expect(callsOf('docker image rm')[0]?.args).toEqual(['image', 'rm', '--', image]);
    expect(callsOf('docker image prune')[0]?.args).toEqual([
      'image',
      'prune',
      '--force',
      '--filter',
      'label=launchway.check=trail',
    ]);
    // Images the repository names come from their registry, never from the node.
    expect(callsOf('compose pull')[0]?.args.slice(-4)).toEqual([
      'pull',
      '--policy',
      'always',
      '--ignore-buildable',
    ]);

    const lines = linesOf('req-1');
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i));
    expect(lines.map((l) => l.line)).toEqual(
      expect.arrayContaining([
        'Fetching main (3f786850e387)',
        `checked out ${SHA}`,
        'service "dev": the repository is mounted from the source volume at /workspace',
        'service "db": "config/init.sql" is passed as a file at /docker-entrypoint-initdb.d/init.sql',
        '#1 building',
        'Handing the source volume to tester',
        'check output',
        'check warning',
        'exited with code 0',
      ]),
    );
    expect(lines.find((l) => l.line === 'check warning')?.stream).toBe('stderr');
    expect(
      lines.find((l) => l.line.startsWith('$ docker compose') && l.line.includes(' run '))?.line,
    ).toMatch(/ dev sh -c "npm ci && npm run check"$/);

    // The token stays out of every message and every argv; git gets it from its environment only.
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(AUTH);
    expect(lines.some((l) => l.line.includes('[redacted]'))).toBe(true);
    expect(JSON.stringify(fake.calls.map((c) => c.args))).not.toContain('Authorization');
    const fetch = callsOf('git fetch')[0];
    expect(Object.values(fetch?.options.env ?? {})).toContain(`Authorization: ${AUTH}`);
    for (const call of fake.calls.filter((c) => c.command === 'docker')) {
      expect(JSON.stringify(call.options.env)).not.toContain('GIT_CONFIG');
    }
    expect(checks.activeCheckRunIds()).toEqual([]);
  });

  it('writes check.env (0600) and compose.json outside the checkout', async () => {
    const checks = manager();
    const run = payload();
    const project = checkProjectName('trail', run.runId);
    let env = '';
    let document: Record<string, unknown> = {};
    let mode = 0;
    fake.on['compose build'] = async (call) => {
      const dir = join(root, 'checks', APP.id, run.runId);
      env = await readFile(join(dir, 'check.env'), 'utf8');
      mode = (await stat(join(dir, 'check.env'))).mode & 0o777;
      document = JSON.parse(await readFile(join(dir, 'compose.json'), 'utf8'));
      expect(call.args).toContain(join(dir, 'compose.json'));
      return {};
    };
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    expect(mode).toBe(0o600);
    expect(env).toBe(
      [
        "CI='true'",
        `COMPOSE_PROJECT_NAME='${project}'`,
        "LAUNCHWAY_APP='trail'",
        "LAUNCHWAY_CHECK='1'",
        `LAUNCHWAY_CHECK_RUN_ID='${run.runId}'`,
        `LAUNCHWAY_COMMIT_SHA='${SHA}'`,
        "LAUNCHWAY_REF='main'",
        '',
      ].join('\n'),
    );
    const services = document.services as Record<string, Record<string, unknown>>;
    expect(document.name).toBe(project);
    expect(services.dev?.image).toBe(checkImageName('trail', 'dev', run.runId));
    expect(services.dev?.labels).toEqual({ 'launchway.check': run.runId });
    expect(services.db?.configs).toEqual([
      { source: 'launchway-check-file-1', target: '/docker-entrypoint-initdb.d/init.sql' },
    ]);
    expect(document.configs).toEqual({
      'launchway-check-file-1': { content: 'select 1; -- $$HOME\n' },
    });
  });

  it.each<[string, number, boolean, Partial<CheckResultPayload>]>([
    ['a failing command', 3, false, { exitCode: 3, message: 'Exited with code 3' }],
    ['an OOM kill', 137, true, { exitCode: 137, message: 'Exited with code 137 (out of memory)' }],
  ])('reports %s with its exit code', async (_label, code, oom, expected) => {
    fake.exitCode = code;
    fake.oomKilled = oom;
    const checks = manager();
    const run = payload();
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toEqual({ runId: run.runId, reason: 'exit', ...expected });
  });

  it('times out: stops the CLI, kills the container and reports timeout', async () => {
    fake.on['compose run'] = blockUntilAborted;
    const checks = manager();
    const run = payload({ check: { ...payload().check, timeoutMs: 1_000 } });
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toEqual({
      runId: run.runId,
      reason: 'timeout',
      exitCode: null,
      message: 'Timed out after 1 second',
    });
    const project = checkProjectName('trail', run.runId);
    expect(callsOf('docker kill').map((c) => c.args)).toContainEqual([
      'kill',
      '--',
      `${project}-check`,
    ]);
    expect(callsOf('docker container inspect')).toHaveLength(0);
    await cleanedUp(run);
    expect(callsOf('compose down')).toHaveLength(1);
  });

  it('runs every run it gets at once, each with names, files and a log of its own', async () => {
    const commands = held();
    fake.on['compose run'] = commands.handler;
    const checks = manager();
    const [a, b, c] = [payload(), payload(), payload()];
    checks.run('req-a', a);
    checks.run('req-b', b);
    checks.run('req-c', c);
    // The API decides how many run at once; the agent runs what it gets, side by side.
    await waitFor(() => callsOf('compose run').length === 3);
    expect(results()).toEqual([]);
    expect(checks.activeCheckRunIds()).toEqual([a.runId, b.runId, c.runId]);
    const projectOf = (call: Call) => call.args[call.args.indexOf('-p') + 1];
    const nameOf = (call: Call) => call.args[call.args.indexOf('--name') + 1];
    const runs = callsOf('compose run');
    // In any order: their builds take turns in the check builder.
    const each = (name: (run: CheckRunPayload) => string) => [a, b, c].map(name).sort();
    const project = (run: CheckRunPayload) => checkProjectName('trail', run.runId);
    expect(runs.map(projectOf).sort()).toEqual(each(project));
    expect(runs.map(nameOf).sort()).toEqual(each((run) => `${project(run)}-check`));
    expect(new Set(runs.map((call) => call.options.cwd)).size).toBe(3);
    expect(callsOf('docker container create').map(nameOf).sort()).toEqual(
      each((run) => `${project(run)}-source`),
    );
    // Every run builds and runs an image tagged with the run, never one another run retags.
    expect(
      callsOf('docker run')
        .map((call) => call.args.at(-6))
        .sort(),
    ).toEqual(each((run) => checkImageName('trail', 'dev', run.runId)));
    for (const [id, run] of [
      ['req-a', a],
      ['req-b', b],
      ['req-c', c],
    ] as const) {
      const lines = linesOf(id);
      expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i));
      const ofRun = (m: AgentToServerMessage) =>
        (m.type === 'check.log' || m.type === 'check.result') && m.payload.runId === run.runId;
      expect(messages.filter((m) => m.id === id).every(ofRun)).toBe(true);
    }
    commands.release();
    await waitFor(() => results().length === 3);
    for (const run of [a, b, c]) await cleanedUp(run);
    expect(results().map((r) => r.reason)).toEqual(['exit', 'exit', 'exit']);
    expect(callsOf('compose down')).toHaveLength(3);
  });

  it('cancels one of the runs: reports at once, stops and cleans up its own, the others go on', async () => {
    const commands = held();
    fake.on['compose run'] = commands.handler;
    const checks = manager();
    const [a, b] = [payload(), payload()];
    checks.run('req-a', a);
    checks.run('req-b', b);
    await waitFor(() => callsOf('compose run').length === 2);
    expect(checks.cancel(a.runId)).toBe(true);
    // Reported synchronously, before the container is even killed.
    expect(results()).toEqual([
      { id: 'req-a', runId: a.runId, reason: 'cancelled', exitCode: null },
    ]);
    expect(checks.cancel(a.runId)).toBe(false);
    expect(checks.activeCheckRunIds()).toEqual([b.runId]);
    await cleanedUp(a);
    const own = checkProjectName('trail', a.runId);
    const other = checkProjectName('trail', b.runId);
    expect(callsOf('docker kill').map((call) => call.args)).toEqual([
      ['kill', '--', `${own}-check`],
      ['kill', '--', `${own}-check`],
    ]);
    // The cleanup names only the cancelled run: its label, project, source volume and image.
    const cleanup = fake.calls.slice(fake.calls.indexOf(callsOf('compose down')[0] as Call) - 1);
    expect(cleanup[0]?.args).toContain(`label=launchway.check=${a.runId}`);
    for (const call of cleanup) expect(call.args.join(' ')).not.toContain(b.runId.slice(4));
    expect(callsOf('compose down').map((call) => call.args[call.args.indexOf('-p') + 1])).toEqual([
      own,
    ]);
    expect(callsOf('docker image rm')[0]?.args).toEqual([
      'image',
      'rm',
      '--',
      checkImageName('trail', 'dev', a.runId),
    ]);
    expect(resultOf('req-b')).toBeUndefined();
    commands.release();
    await waitFor(() => results().length === 2);
    expect(resultOf('req-b')).toEqual({ runId: b.runId, reason: 'exit', exitCode: 0 });
    await cleanedUp(b);
    expect(callsOf('compose down').map((call) => call.args[call.args.indexOf('-p') + 1])).toEqual([
      own,
      other,
    ]);
    // Nothing is logged after the result.
    const after = messages.findIndex((m) => m.id === 'req-a' && m.type === 'check.result');
    expect(messages.slice(after + 1).some((m) => m.id === 'req-a')).toBe(false);
  });

  it('reports a run before its cleanup and starts the next one meanwhile', async () => {
    const down = gate();
    fake.on['compose down'] = down.handler;
    const checks = manager();
    const a = payload();
    checks.run('req-a', a);
    await waitFor(() => down.entered() === 1);
    expect(resultOf('req-a')).toMatchObject({ reason: 'exit', exitCode: 0 });
    expect(checks.activeCheckRunIds()).toEqual([]);
    expect(checks.cancel(a.runId)).toBe(false);
    const b = payload();
    checks.run('req-b', b);
    await waitFor(() => callsOf('compose run').length === 2);
    expect(callsOf('git init')).toHaveLength(2);
    down.release();
    await waitFor(() => results().length === 2);
    await cleanedUp(a);
    await cleanedUp(b);
  });

  it('builds one run at a time in the check builder, prunes it between builds, runs side by side', async () => {
    const build = gate();
    fake.on['compose build'] = build.handler;
    const commands = held();
    fake.on['compose run'] = commands.handler;
    const checks = manager();
    const [a, b] = [payload(), payload()];
    checks.run('req-a', a);
    checks.run('req-b', b);
    await waitFor(() => build.entered() === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // b waits for the builder: its cache mounts are emptied only once a's build is done.
    expect(build.entered()).toBe(1);
    expect(callsOf('docker update')).toHaveLength(1);
    expect(callsOf('compose config')).toHaveLength(2);
    // The run that waits says so: its time as running includes the wait.
    const waiting = (id: string) =>
      linesOf(id).some(
        (l) =>
          l.stream === 'system' &&
          l.line === 'waiting for the check builder: another check is building',
      );
    // Log lines go out in batches.
    await waitFor(() => waiting('req-a') || waiting('req-b'));
    expect([waiting('req-a'), waiting('req-b')].filter(Boolean)).toHaveLength(1);
    build.release();
    await waitFor(() => callsOf('compose run').length === 2);
    expect(build.entered()).toBe(2);
    const events = fake.events;
    const builds = events.flatMap((e, i) => (e === 'compose build' ? [i] : []));
    const boots = events.flatMap((e, i) => (e === 'docker update' ? [i] : []));
    expect(boots[1]).toBeGreaterThan(builds[0] as number);
    const emptied = callsOf('docker buildx').filter((c) => c.args.includes('type=exec.cachemount'));
    expect(emptied).toHaveLength(2);
    commands.release();
    await waitFor(() => results().length === 2);
    await cleanedUp(a);
    await cleanedUp(b);
    // Each run prunes the builder after it ran: the cache mounts, then the cache to its bound.
    expect(
      callsOf('docker buildx').filter((c) => c.args.includes('--max-used-space')),
    ).toHaveLength(2);
  });

  it('never prunes the check builder or dangling images while another run builds', async () => {
    const build = gate();
    let builds = 0;
    fake.on['compose build'] = (call) => {
      builds += 1;
      return builds === 1 ? {} : build.handler(call);
    };
    const commands = held();
    fake.on['compose run'] = commands.handler;
    const pruned = () =>
      callsOf('docker buildx').filter((c) => c.args.includes('--max-used-space')).length;
    const checks = manager();
    const [a, b] = [payload(), payload()];
    checks.run('req-a', a);
    await waitFor(() => callsOf('compose run').length === 1);
    checks.run('req-b', b);
    await waitFor(() => build.entered() === 1);
    // a ends while b builds: a removes its containers, volumes and networks, but untagging its
    // image and the prunes wait for b's build (which loads its image, untagged for a moment and
    // maybe the same one, and uses the builder's cache mounts).
    commands.release();
    await waitFor(() => resultOf('req-a') !== undefined && callsOf('docker network ls').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsOf('docker image rm')).toHaveLength(0);
    expect(callsOf('docker image prune')).toHaveLength(0);
    expect(pruned()).toBe(0);
    build.release();
    await waitFor(() => results().length === 2);
    await cleanedUp(a);
    await cleanedUp(b);
    expect(callsOf('docker image rm')).toHaveLength(2);
    expect(callsOf('docker image prune')).toHaveLength(2);
    expect(pruned()).toBe(2);
  });

  it('caps the log, ends it with one truncation line and keeps the tail for the message', async () => {
    fake.on['compose build'] = (call) => {
      for (let i = 0; i < 25_000; i += 1) call.options.onStdoutLine?.(`build-line-${i}`);
      call.options.onStderrLine?.(`ERROR: failed to solve (token ${TOKEN})`);
      return { code: 1 };
    };
    const checks = manager();
    const run = payload();
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    const lines = linesOf('req-1');
    expect(lines).toHaveLength(CHECK_LOG_LINE_LIMIT + 1);
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i));
    expect(lines.at(-1)).toMatchObject({
      stream: 'system',
      line: '… output truncated after 20000 lines',
    });
    expect(messages.every((m) => m.type !== 'check.log' || m.payload.lines.length <= 500)).toBe(
      true,
    );
    const result = resultOf('req-1');
    expect(result).toMatchObject({ reason: 'build', exitCode: null });
    expect(result?.message).toMatch(
      /^Command failed \(exit 1\): docker compose build\n--- last log lines ---\n/,
    );
    expect(result?.message).toContain('build-line-24999');
    expect(result?.message).toContain('ERROR: failed to solve (token [redacted])');
    expect(result?.message?.length).toBeLessThanOrEqual(2000);
  });

  it('refuses a policy violation before building and creates nothing on Docker', async () => {
    fake.config = (dir, project) => {
      const config = trailConfig(dir, project);
      config.services.dev.volumes.push({ type: 'bind', source: '/etc', target: '/host', bind: {} });
      return config;
    };
    const checks = manager();
    const run = payload();
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'policy', exitCode: null });
    expect(resultOf('req-1')?.message).toMatch(
      /^Compose policy violation: service "dev": bind mount "\/etc" is not allowed/,
    );
    expect(linesOf('req-1').some((l) => l.line.startsWith('policy: service "dev"'))).toBe(true);
    await cleanedUp(run);
    expect(
      fake.calls.filter((c) => c.command === 'docker').map((c) => keyOf(c.command, c.args)),
    ).toEqual(['compose config']);
  });

  it('refuses include before Compose reads anything', async () => {
    fake.composeYaml = 'include:\n  - path: compose.yaml\n    env_file: ../../../apps/a/d/.env\n';
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({
      reason: 'policy',
      exitCode: null,
      message:
        "compose.yaml: checks do not support include; list the files in the check's Compose files",
    });
    expect(fake.calls.filter((c) => c.command === 'docker')).toEqual([]);
  });

  it('reports a Compose file that is no valid YAML as build', async () => {
    fake.composeYaml = 'services: [\n';
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'build', exitCode: null });
    expect(resultOf('req-1')?.message).toMatch(/^compose\.yaml is not valid YAML/);
  });

  it('refuses a project without the check service', async () => {
    const checks = manager();
    const run = payload({ check: { ...payload().check, service: 'web' } });
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toEqual({
      runId: run.runId,
      reason: 'policy',
      exitCode: null,
      message: 'The service "web" of the check does not exist in the Compose project',
    });
  });

  it.each<[string, (fake: Fake) => void, RegExp]>([
    [
      'a failed fetch',
      (f) => (f.on['git fetch'] = () => ({ code: 128 })),
      /^Command failed \(exit 128\): git fetch/,
    ],
    [
      'a moved commit',
      (f) => (f.head = 'b'.repeat(40)),
      /^Checked out b{40} but the check expects/,
    ],
    [
      'a missing Compose file',
      (f) => (f.on['git checkout'] = () => ({})),
      /^"compose.yaml" does not exist in the repository at this ref$/,
    ],
    [
      'an unreadable configuration',
      (f) => (f.config = () => ({ services: 'x' })),
      /^Could not read the Compose configuration$/,
    ],
    ['a failed pull', (f) => (f.on['compose pull'] = () => ({ code: 18 })), /docker compose pull/],
  ])('reports %s as build', async (_label, arrange, pattern) => {
    arrange(fake);
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'build', exitCode: null });
    expect(resultOf('req-1')?.message).toMatch(pattern);
  });

  it.each<[string, (fake: Fake) => void, RegExp]>([
    [
      'a dependency that does not start',
      (f) => {
        f.on['compose run'] = (call) => {
          call.options.onStderrLine?.('dependency failed to start: container x-db-1 is unhealthy');
          return { code: 1 };
        };
        f.on['docker container inspect'] = () => ({ code: 1 });
      },
      /^The check container did not start\n--- last log lines ---\n[\s\S]*dependency failed to start/,
    ],
    [
      'a container that never started',
      (f) => {
        f.on['docker container inspect'] = () => ({
          stdout: JSON.stringify({
            Running: false,
            ExitCode: 128,
            StartedAt: '0001-01-01T00:00:00Z',
            Error: 'cannot access path',
          }),
        });
      },
      /^The check container did not start: cannot access path/,
    ],
    [
      'a failed copy',
      (f) => (f.on['docker cp'] = () => ({ code: 1 })),
      /^Command failed \(exit 1\): docker cp/,
    ],
    [
      'a failed chown',
      (f) => (f.on['docker run'] = () => ({ code: 1 })),
      /^Command failed \(exit 1\): chown of the source volume/,
    ],
    [
      'a missing docker CLI',
      (f) => {
        f.on['compose config'] = () => {
          throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        };
      },
      /^Could not start docker \(ENOENT\)/,
    ],
  ])('reports %s as infrastructure', async (_label, arrange, pattern) => {
    arrange(fake);
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'infrastructure', exitCode: null });
    expect(resultOf('req-1')?.message).toMatch(pattern);
  });

  it.each<[string, string, string | null]>([
    ['a root image', '', null],
    ['an image running as 0:0', '0:0', null],
    ['an image running as root:root', 'root:root', null],
    ['a numeric user', '1000:1000', '1000:1000'],
  ])('hands the source volume to the user of %s', async (_label, user, owner) => {
    fake.imageUser = user;
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'exit' });
    const chown = callsOf('docker run')[0];
    if (owner === null) expect(chown).toBeUndefined();
    else expect(chown?.args.slice(-2)).toEqual([owner, '/src']);
  });

  it('takes the owner from the service user before the image, and refuses odd names', async () => {
    fake.config = (dir, project) => {
      const config = trailConfig(dir, project);
      return {
        ...config,
        services: { ...config.services, dev: { ...config.services.dev, user: 'node' } },
      };
    };
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(callsOf('docker image inspect')).toHaveLength(0);
    expect(callsOf('docker run')[0]?.args.slice(-2)).toEqual(['node', '/src']);

    messages = [];
    fake.imageUser = '--reference=/etc';
    fake.config = trailConfig;
    checks.run('req-2', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-2')).toMatchObject({ reason: 'policy' });
    expect(callsOf('docker run')).toHaveLength(1);
  });

  it('copies nothing when no service binds the repository', async () => {
    fake.config = (dir) => ({ services: { dev: { build: { context: dir }, command: ['true'] } } });
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'exit', exitCode: 0 });
    for (const key of [
      'docker volume create',
      'docker container create',
      'docker cp',
      'docker run',
    ]) {
      expect(callsOf(key)).toHaveLength(0);
    }
  });

  it('builds in the node build slots it shares with deployments', async () => {
    const builds = new Semaphore(1);
    let release = () => {};
    const holding = builds.use(() => new Promise<void>((resolve) => (release = resolve)));
    const checks = manager(builds);
    const [a, b] = [payload(), payload()];
    checks.run('req-a', a);
    await waitFor(() => callsOf('compose config').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsOf('compose build')).toHaveLength(0);
    // Cancelling while it waits for a slot reports at once and builds nothing.
    expect(checks.cancel(a.runId)).toBe(true);
    expect(resultOf('req-a')).toMatchObject({ reason: 'cancelled' });
    checks.run('req-b', b);
    await waitFor(() => callsOf('compose config').length === 2);
    release();
    await holding;
    await waitFor(() => results().length === 2);
    expect(resultOf('req-b')).toMatchObject({ reason: 'exit', exitCode: 0 });
    expect(callsOf('compose build')).toHaveLength(1);
  });

  it('on shutdown interrupts every running run at once, cleans each up and refuses new ones', async () => {
    fake.on['compose run'] = blockUntilAborted;
    const checks = manager();
    const [a, b] = [payload(), payload()];
    checks.run('req-a', a);
    checks.run('req-b', b);
    await waitFor(() => callsOf('compose run').length === 2);
    const stopped = checks.shutdown(2_000);
    const interrupted = {
      reason: 'interrupted',
      exitCode: null,
      message: 'Interrupted: the agent shut down',
    };
    expect(results()).toEqual([
      { id: 'req-a', runId: a.runId, ...interrupted },
      { id: 'req-b', runId: b.runId, ...interrupted },
    ]);
    await stopped;
    // Both containers are stopped and both runs cleaned up, side by side within the grace period.
    const killed = new Set(callsOf('docker kill').map((call) => call.args.at(-1)));
    expect(killed).toEqual(
      new Set([a, b].map((run) => `${checkProjectName('trail', run.runId)}-check`)),
    );
    expect(callsOf('compose down').map((call) => call.args[call.args.indexOf('-p') + 1])).toEqual(
      expect.arrayContaining([a, b].map((run) => checkProjectName('trail', run.runId))),
    );
    expect(callsOf('compose down')).toHaveLength(2);
    expect(callsOf('git init')).toHaveLength(2);
    for (const run of [a, b]) {
      await expect(stat(join(root, 'checks', run.app.id, run.runId))).rejects.toThrow();
    }
    // The images of the runs go too, but not the prunes of the check builder: the grace is short,
    // and the next build empties the cache mounts first. Only the builds emptied them here.
    expect(
      callsOf('docker image rm')
        .map((call) => call.args.at(-1))
        .sort(),
    ).toEqual([a, b].map((run) => checkImageName('trail', 'dev', run.runId)).sort());
    const prunes = callsOf('docker buildx').filter((call) => call.args.includes('prune'));
    expect(prunes.filter((call) => call.args.includes('--max-used-space'))).toEqual([]);
    expect(prunes).toHaveLength(2);
    const c = payload();
    checks.run('req-c', c);
    expect(resultOf('req-c')).toEqual({
      runId: c.runId,
      reason: 'interrupted',
      exitCode: null,
      message: 'Interrupted: the agent is shutting down',
    });
  });

  it('repeats the result of a finished run instead of running it again', async () => {
    const checks = manager();
    const run = payload();
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    checks.run('req-2', run);
    expect(resultOf('req-2')).toEqual(resultOf('req-1'));
    expect(linesOf('req-2')).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsOf('git init')).toHaveLength(1);
  });

  it('masks quoted file content in the output of docker compose config', async () => {
    // What Compose prints for `label_file: /var/lib/launchway/agent/credentials.json`.
    const leak = `{"nodeId":"node_x","credential":"${NODE_CREDENTIAL}","other":"s3cr3t-value-123"}`;
    fake.on['compose config'] = (call) => {
      call.options.onStderrLine?.(
        `failed to read /var/lib/launchway/agent/credentials.json: line 1: unexpected character "{" in variable name ${JSON.stringify(leak)}`,
      );
      call.options.onStderrLine?.('service "dev" refers to undefined volume "cache"');
      return { code: 1 };
    };
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    const lines = linesOf('req-1').map((l) => l.line);
    expect(lines).toEqual(
      expect.arrayContaining([
        'failed to read /var/lib/launchway/agent/credentials.json: line 1: unexpected character "{" in variable name "…"',
        'service "dev" refers to undefined volume "cache"',
        'Quoted text in the output of docker compose config is masked: it may quote files outside the repository',
      ]),
    );
    expect(resultOf('req-1')).toMatchObject({ reason: 'build', exitCode: null });
    expect(resultOf('req-1')?.message).toContain('variable name "…"');
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain('s3cr3t-value-123');
    expect(everything).not.toContain(NODE_CREDENTIAL);
  });

  it("redacts the agent's own credential from every line and message", async () => {
    fake.on['compose run'] = (call) => {
      call.options.onStdoutLine?.(`token: ${NODE_CREDENTIAL}`);
      return {};
    };
    fake.on['docker container inspect'] = () => ({ code: 1 });
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(linesOf('req-1').map((l) => l.line)).toContain('token: [redacted]');
    expect(resultOf('req-1')?.message).toContain('token: [redacted]');
    expect(JSON.stringify(messages)).not.toContain(NODE_CREDENTIAL);
  });

  it('runs docker and compose without the proxy settings; git keeps them', async () => {
    const env = {
      PATH: process.env.PATH ?? '',
      HTTPS_PROXY: 'http://user:proxy-secret@proxy:3128',
      http_proxy: 'http://user:proxy-secret@proxy:3128',
      NO_PROXY: 'localhost',
    };
    const checks = new CheckManager({
      logger,
      send: (message) => messages.push(message),
      workspace: new Workspace(root),
      builds: new Semaphore(1),
      run: fake.run,
      env,
    });
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({ reason: 'exit', exitCode: 0 });
    for (const call of fake.calls) {
      const values = JSON.stringify(call.options.env);
      if (call.command === 'git') expect(values).toContain('proxy-secret');
      else expect(values).not.toMatch(/proxy-secret|NO_PROXY/);
    }
  });

  it('caps the log at 16 MiB of text with the same truncation line', async () => {
    const big = 'x'.repeat(16_000);
    fake.on['compose run'] = (call) => {
      for (let i = 0; i < 1_200; i += 1) call.options.onStdoutLine?.(big);
      return { code: 1 };
    };
    fake.exitCode = 1;
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    const lines = linesOf('req-1');
    const bytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l.line), 0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 100);
    expect(lines.length).toBeLessThan(1_200);
    expect(lines.at(-1)).toMatchObject({
      stream: 'system',
      line: `… output truncated after ${lines.length - 1} lines`,
    });
    expect(resultOf('req-1')).toMatchObject({ reason: 'exit', exitCode: 1 });
  });

  it('refuses a project that names more than 256 bind mount sources', async () => {
    fake.config = (dir, project) => {
      const config = trailConfig(dir, project);
      config.services.dev.volumes = Array.from({ length: 300 }, (_, i) => ({
        type: 'bind',
        source: `${dir}/d${i}`,
        target: `/d${i}`,
        bind: {},
      }));
      return config;
    };
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({
      reason: 'policy',
      message:
        'The project names 301 bind mount sources, configs and secrets; checks allow at most 256',
    });
  });

  it('refuses more than 1 MiB of small files to read', async () => {
    fake.on['git checkout'] = async (call) => {
      const dir = call.options.cwd as string;
      await writeFile(join(dir, 'compose.yaml'), 'services: {}\n');
      await mkdir(join(dir, 'config'), { recursive: true });
      await writeFile(join(dir, 'config', 'init.sql'), 'select 1;\n');
      for (let i = 0; i < 20; i += 1) await writeFile(join(dir, `f${i}.txt`), 'x'.repeat(60_000));
      return {};
    };
    fake.config = (dir, project) => {
      const config = trailConfig(dir, project);
      config.services.dev.volumes = Array.from({ length: 20 }, (_, i) => ({
        type: 'bind',
        source: `${dir}/f${i}.txt`,
        target: `/f${i}.txt`,
        read_only: true,
        bind: {},
      }));
      return config;
    };
    const checks = manager();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(resultOf('req-1')).toMatchObject({
      reason: 'policy',
      message: "The project's small files to mount or pass inline exceed 1 MiB in total",
    });
  });

  it('answers cancel of an unknown run with false', () => {
    expect(manager().cancel(generateId('chk'))).toBe(false);
  });
});

describe('CheckManager.sweep', () => {
  const x = checkProjectName('trail', generateId('chk'));
  const y = checkProjectName('trail', generateId('chk'));
  const other = checkProjectName('zeus-api', generateId('chk'));

  function leftovers(): void {
    fake.on['docker ps'] = () => ({
      stdout: [
        `c1\t${x}-check\t${x}`,
        'c2\tlaunchway-trail-web-1\tlaunchway-trail',
        `c3\t${y}-source\t`,
        'c4\tzeus-db-1\tzeus',
        // An app with the slug `check` (project launchway-check), labelled by its own Compose file.
        'c5\tlaunchway-check-web-1\tlaunchway-check',
        'c6\tlaunchway-check_web_1\tlaunchway-check',
        `c7\t${other}-check\t${other}`,
        `c8\t${x}x-check\t${x}x`,
      ].join('\n'),
    });
    fake.on['docker volume ls'] = () => ({
      stdout: [
        `${x}_source`,
        'trail_data',
        `${x}_db`,
        'launchway-check_db',
        'launchway-check_data_volume',
        `${other}_source`,
        `${x}`,
        '',
      ].join('\n'),
    });
    fake.on['docker network ls'] = () => ({
      stdout: [`n1\t${x}_default`, 'n2\ttrail-feat_default', 'n3\tlaunchway-check_default'].join(
        '\n',
      ),
    });
    fake.on['docker image ls'] = () => ({
      stdout: [
        `launchway-check/trail-dev:${x.slice(-26)}`,
        'launchway-check/trail-dev:latest',
        '<none>:<none>',
        // Labelled by its own Dockerfile: not an image of the check namespace.
        'ghcr.io/acme/trail:1',
      ].join('\n'),
    });
  }

  it('removes only leftovers of check runs, then the run directories', async () => {
    await mkdir(join(root, 'checks', APP.id, 'chk_old', 'src'), { recursive: true });
    leftovers();
    const checks = manager();
    checks.sweep();
    const run = payload();
    checks.run('req-1', run);
    await waitFor(() => results().length === 1);
    const keys = fake.calls.map((c) => keyOf(c.command, c.args));
    expect(keys.slice(0, keys.indexOf('git init'))).toEqual([
      'docker ps',
      'docker rm',
      'compose down',
      'compose down',
      'docker volume ls',
      'docker volume rm',
      'docker network ls',
      'docker network rm',
      'docker image ls',
      'docker image rm',
      'docker image prune',
      // Check builders unused for a day: none here, so their network goes.
      'docker ps',
      'docker network rm',
    ]);
    const args = (key: string) => callsOf(key)[0]?.args;
    expect(args('docker ps')).toEqual([
      'ps',
      '--all',
      '--filter',
      'label=launchway.check',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}',
    ]);
    expect(args('docker rm')).toEqual(['rm', '--force', '--volumes', '--', 'c1', 'c3', 'c7']);
    const sweepCalls = fake.calls.slice(0, keys.indexOf('git init'));
    expect(
      sweepCalls
        .filter((c) => keyOf(c.command, c.args) === 'compose down')
        .map((c) => c.args[c.args.indexOf('-p') + 1]),
    ).toEqual([x, other]);
    expect(args('docker volume rm')).toEqual([
      'volume',
      'rm',
      '--force',
      '--',
      `${x}_source`,
      `${x}_db`,
      `${other}_source`,
    ]);
    expect(args('docker network rm')).toEqual(['network', 'rm', '--', 'n1']);
    // Every tag of the check namespace: of runs, and the per-app ones of older agents.
    expect(args('docker image ls')).toEqual([
      'image',
      'ls',
      '--filter',
      'label=launchway.check',
      '--format',
      '{{.Repository}}:{{.Tag}}',
    ]);
    expect(args('docker image rm')).toEqual([
      'image',
      'rm',
      '--',
      `launchway-check/trail-dev:${x.slice(-26)}`,
      'launchway-check/trail-dev:latest',
    ]);
    expect(args('docker image prune')).toEqual([
      'image',
      'prune',
      '--force',
      '--filter',
      'label=launchway.check',
    ]);
    await expect(stat(join(root, 'checks', APP.id, 'chk_old'))).rejects.toThrow();
    expect(resultOf('req-1')).toMatchObject({ reason: 'exit', exitCode: 0 });
  });

  it('waits for the runs before it and holds back the runs after it', async () => {
    const commands = held();
    fake.on['compose run'] = commands.handler;
    const checks = manager();
    const a = payload();
    checks.run('req-a', a);
    await waitFor(() => callsOf('compose run').length === 1);
    checks.sweep({ slug: 'trail' });
    const b = payload();
    checks.run('req-b', b);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sweeps = () =>
      callsOf('docker ps').filter((c) => c.args.includes('label=launchway.check'));
    // The sweep would remove a's project; b would wait for it anyway.
    expect(sweeps()).toHaveLength(0);
    expect(callsOf('git init')).toHaveLength(1);
    commands.release();
    await waitFor(() => results().length === 2);
    const events = fake.calls;
    const sweep = events.indexOf(sweeps()[0] as Call);
    const aDown = events.indexOf(callsOf('compose down')[0] as Call);
    const bInit = events.indexOf(callsOf('git init')[1] as Call);
    expect(aDown).toBeLessThan(sweep);
    expect(sweep).toBeLessThan(bInit);
    await cleanedUp(b);
  });

  it("limits itself to one app's runs when asked", async () => {
    leftovers();
    const checks = manager();
    checks.sweep({ slug: 'zeus-api' });
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    const args = (key: string) => callsOf(key)[0]?.args;
    expect(args('docker rm')).toEqual(['rm', '--force', '--volumes', '--', 'c7']);
    expect(args('docker volume rm')).toEqual(['volume', 'rm', '--force', '--', `${other}_source`]);
    expect(callsOf('docker network rm').filter((c) => c.args.includes('n1'))).toEqual([]);
    expect(args('docker image prune')).toContain('label=launchway.check=zeus-api');
  });

  it('looks for idle check builders at start and every hour, until it shuts down', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const listings = () =>
        fake.calls.filter(
          (c) =>
            c.args[0] === 'ps' && c.args.includes('name=^buildx_buildkit_launchway-check-build-'),
        ).length;
      const checks = manager();
      checks.sweep();
      await waitFor(() => listings() === 1);
      vi.advanceTimersByTime(60 * 60_000);
      await waitFor(() => listings() === 2);
      // An app's sweep leaves the builders alone and starts no second timer.
      checks.sweep({ slug: 'trail' });
      vi.advanceTimersByTime(60 * 60_000);
      await waitFor(() => listings() === 3);
      await checks.shutdown(1_000);
      vi.advanceTimersByTime(3 * 60 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(listings()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves Docker alone when it cannot list the leftovers', async () => {
    fake.on['docker ps'] = () => ({ code: 1 });
    const checks = manager();
    checks.sweep();
    checks.run('req-1', payload());
    await waitFor(() => results().length === 1);
    const keys = fake.calls.map((c) => keyOf(c.command, c.args));
    // The leftovers and the check builders: neither listed, nothing removed.
    expect(keys.slice(0, keys.indexOf('git init'))).toEqual(['docker ps', 'docker ps']);
  });
});
