import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentToServerMessage, type DeployPayload, generateId } from '@slipway/contracts';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeploymentManager, Semaphore } from './deployments.js';
import type { Runner, RunOptions, RunResult } from './exec.js';
import { Workspace } from './workspace.js';

const logger = pino({ level: 'silent' });
const SHA = '3f786850e387550fdab836ed7e6dc881de23001b';
const AUTH = `basic ${Buffer.from('x-access-token:ghs_supersecrettoken123').toString('base64')}`;

interface Call {
  command: string;
  args: string[];
  options: RunOptions;
}

interface FakeDocker {
  run: Runner;
  calls: Call[];
  /** Overrides per compose subcommand (config, build, pull, up, ps). */
  on: Partial<Record<string, (call: Call) => Promise<Partial<RunResult>> | Partial<RunResult>>>;
  head: string;
}

const ok = (stdout = ''): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  aborted: false,
  timedOut: false,
});

const defaultConfig = (
  services: Record<string, unknown> = { web: { image: 'nginx', networks: { default: null } } },
) => JSON.stringify({ name: 'slipway-trail', services });

function fakeDocker(): FakeDocker {
  const fake: FakeDocker = {
    calls: [],
    on: {},
    head: SHA,
    run: async (command, args, options = {}) => {
      const call = { command, args: [...args], options };
      fake.calls.push(call);
      if (command === 'git') {
        if (args[0] === 'clone') {
          const dir = args.at(-1) as string;
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'compose.yaml'), 'services: {}');
          options.onStderrLine?.(`Cloning into '${dir}'... using ${AUTH}`);
        }
        if (args[0] === 'rev-parse') return ok(`${fake.head}\n`);
        return ok();
      }
      const sub = ['config', 'build', 'pull', 'up', 'ps', 'inspect', 'create'].find((name) =>
        args.includes(name),
      );
      const handler = sub ? fake.on[sub] : undefined;
      if (handler) return { ...ok(), ...(await handler(call)) };
      if (sub === 'config') return ok(defaultConfig());
      if (sub === 'ps') {
        return ok(
          `${JSON.stringify({ ID: 'c1', Name: 'slipway-trail-web-1', Service: 'web', State: 'running', Health: '', Publishers: [] })}\n`,
        );
      }
      if (sub === 'build') options.onStdoutLine?.('#1 building');
      return ok();
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

let root: string;
let messages: AgentToServerMessage[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slipway-deploy-'));
  messages = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manager(fake: FakeDocker, maxConcurrentBuilds = 2) {
  return new DeploymentManager({
    logger,
    send: (message) => messages.push(message),
    workspace: new Workspace(root),
    run: fake.run,
    env: { PATH: process.env.PATH ?? '' },
    maxConcurrentBuilds,
  });
}

function payload(overrides: Partial<DeployPayload> = {}): DeployPayload {
  return {
    deploymentId: generateId('dep'),
    app: { id: generateId('app'), slug: 'trail' },
    source: {
      cloneUrl: 'https://github.com/acme/trail.git',
      ref: 'v1.0.0',
      commitSha: SHA,
      authorization: AUTH,
    },
    build: { kind: 'compose', composeFiles: ['compose.yaml'] },
    env: { SECRET: 'hunter2-very-secret' },
    routes: [{ service: 'web', port: 80, alias: 'trail-web' }],
    network: { proxyNetwork: 'slipway-proxy', publishOnIp: null },
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const results = () => messages.filter((m) => m.type === 'deployment.result');
const logLines = () =>
  messages.flatMap((m) => (m.type === 'deployment.log' ? m.payload.lines.map((l) => l.line) : []));

describe('DeploymentManager', () => {
  it('acknowledges deploy requests at once, duplicates included', async () => {
    const fake = fakeDocker();
    const deployments = manager(fake);
    const job = payload();
    deployments.deploy('req-1', job);
    deployments.deploy('req-2', job);
    const acks = messages.filter((m) => m.type === 'deployment.log');
    expect(acks.map((m) => m.id)).toEqual(['req-1', 'req-2']);
    expect(logLines().slice(0, 2)).toEqual([
      'Received by the node',
      expect.stringMatching(/^Already /),
    ]);
    await waitFor(() => results().length === 1);
  });

  it('runs a deployment end to end and reports progress, logs and services', async () => {
    const fake = fakeDocker();
    const deployments = manager(fake);
    const job = payload();
    deployments.deploy('req-1', job);
    expect(deployments.activeDeploymentIds()).toEqual([job.deploymentId]);
    await waitFor(() => results().length === 1);

    expect(messages.every((m) => m.id === 'req-1')).toBe(true);
    expect(
      messages.filter((m) => m.type === 'deployment.progress').map((m) => m.payload.status),
    ).toEqual(['cloning', 'building', 'building', 'starting']);
    expect(results()[0]?.payload).toEqual({
      deploymentId: job.deploymentId,
      outcome: 'succeeded',
      services: [
        { service: 'web', containerId: 'c1', state: 'running', health: null, publishedPorts: [] },
      ],
    });
    const seqs = messages.flatMap((m) =>
      m.type === 'deployment.log' ? m.payload.lines.map((l) => l.seq) : [],
    );
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(logLines()).toContain('#1 building');

    const steps = fake.calls.map((c) =>
      c.command === 'git'
        ? `git ${c.args[0]}`
        : c.args
            .filter(
              (a) =>
                /^[a-z]+$/.test(a) &&
                a !== 'compose' &&
                a !== 'never' &&
                a !== 'plain' &&
                a !== 'json',
            )
            .join(' '),
    );
    expect(steps).toEqual([
      'git clone',
      'git rev-parse',
      'config',
      'network inspect',
      'build',
      'pull',
      'up',
      'ps',
    ]);
    const up = fake.calls.find((c) => c.args.includes('up'));
    expect(up?.args).toEqual(
      expect.arrayContaining(['-p', 'slipway-trail', '--detach', '--wait', '--remove-orphans']),
    );
    expect(up?.args.filter((a) => a.endsWith('.yaml')).map((a) => a.split('/').at(-1))).toEqual([
      'compose.yaml',
      'compose.slipway.yaml',
    ]);

    const dir = join(root, 'apps', job.app.id, job.deploymentId);
    const env = await stat(join(dir, '.env'));
    expect(env.mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe("SECRET='hunter2-very-secret'\n");
    const override = JSON.parse(await readFile(join(dir, 'compose.slipway.yaml'), 'utf8'));
    expect(override.services.web.networks['slipway-proxy']).toEqual({ aliases: ['trail-web'] });

    // Never leak credentials or env values into logs; never put them in argv.
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain('ghs_supersecrettoken123');
    expect(everything).not.toContain(AUTH);
    expect(everything).not.toContain('hunter2');
    expect(logLines().some((line) => line.includes('[redacted]'))).toBe(true);
    expect(JSON.stringify(fake.calls.map((c) => c.args))).not.toContain('Authorization');
    const clone = fake.calls[0];
    expect(Object.values(clone?.options.env ?? {})).toContain(`Authorization: ${AUTH}`);
    expect(deployments.activeDeploymentIds()).toEqual([]);
  });

  it('fails with policy-violation before building', async () => {
    const fake = fakeDocker();
    fake.on.config = () => ({ stdout: defaultConfig({ web: { image: 'x', privileged: true } }) });
    const deployments = manager(fake);
    deployments.deploy('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(results()[0]?.payload).toMatchObject({
      outcome: 'failed',
      error: { code: 'policy-violation', retryable: false },
    });
    expect(fake.calls.some((c) => c.args.includes('build'))).toBe(false);
  });

  it('fails with the last log lines when a command fails', async () => {
    const fake = fakeDocker();
    fake.on.build = (call) => {
      call.options.onStderrLine?.(
        'ERROR: failed to solve: process "/bin/sh -c make" did not complete',
      );
      return { code: 1 };
    };
    const deployments = manager(fake);
    deployments.deploy('req-1', payload());
    await waitFor(() => results().length === 1);
    const result = results()[0]?.payload;
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'internal-error' } });
    if (result?.outcome !== 'failed') throw new Error('expected failure');
    expect(result.error.message).toMatch(/docker compose build/);
    expect(result.error.message).toMatch(/failed to solve/);
  });

  it('fails cleanly when a program cannot be started', async () => {
    const fake = fakeDocker();
    fake.on.config = () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    };
    const deployments = manager(fake);
    deployments.deploy('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(results()[0]?.payload).toMatchObject({
      outcome: 'failed',
      error: {
        code: 'internal-error',
        retryable: true,
        message: expect.stringMatching(/Could not start docker \(ENOENT\)/),
      },
    });
  });

  it('fetches the commit when the ref moved since it was resolved', async () => {
    const fake = fakeDocker();
    fake.head = 'b'.repeat(40);
    fake.on.config = () => {
      fake.head = SHA;
      return { stdout: defaultConfig() };
    };
    let revParses = 0;
    const run = fake.run;
    fake.run = async (command, args, options) => {
      if (command === 'git' && args[0] === 'rev-parse' && ++revParses === 2) fake.head = SHA;
      return run(command, args, options);
    };
    const deployments = manager(fake);
    deployments.deploy('req-1', payload());
    await waitFor(() => results().length === 1);
    expect(results()[0]?.payload.outcome).toBe('succeeded');
    expect(fake.calls.filter((c) => c.command === 'git').map((c) => c.args[0])).toEqual([
      'clone',
      'rev-parse',
      'fetch',
      'checkout',
      'rev-parse',
    ]);
  });

  it('cancels a running deployment by killing its process', async () => {
    const fake = fakeDocker();
    fake.on.up = blockUntilAborted;
    const deployments = manager(fake);
    const job = payload();
    deployments.deploy('req-1', job);
    await waitFor(() => fake.calls.some((c) => c.args.includes('up')));
    expect(deployments.cancel(job.deploymentId)).toBe(true);
    await waitFor(() => results().length === 1);
    expect(results()[0]?.payload).toEqual({ deploymentId: job.deploymentId, outcome: 'cancelled' });
    expect(deployments.cancel(job.deploymentId)).toBe(false);
  });

  it('queues deployments of the same app and cancels queued ones immediately', async () => {
    const fake = fakeDocker();
    fake.on.up = blockUntilAborted;
    const deployments = manager(fake);
    const app = { id: generateId('app'), slug: 'trail' };
    const first = payload({ app });
    const second = payload({ app });
    const third = payload({ app });
    deployments.deploy('req-1', first);
    deployments.deploy('req-2', second);
    deployments.deploy('req-3', third);
    deployments.deploy('req-dup', third);
    await waitFor(() => fake.calls.some((c) => c.args.includes('up')));
    expect(fake.calls.filter((c) => c.args[0] === 'clone')).toHaveLength(1);
    expect(deployments.activeDeploymentIds()).toHaveLength(3);

    deployments.cancel(second.deploymentId);
    expect(results().map((m) => m.payload)).toEqual([
      { deploymentId: second.deploymentId, outcome: 'cancelled' },
    ]);

    deployments.cancel(first.deploymentId);
    await waitFor(() => fake.calls.filter((c) => c.args.includes('up')).length === 2);
    expect(fake.calls.filter((c) => c.args[0] === 'clone')).toHaveLength(2);
    deployments.cancel(third.deploymentId);
    await waitFor(() => results().length === 3);
    expect(results().map((m) => m.id)).toEqual(['req-2', 'req-1', 'req-3']);
  });

  it('limits concurrent builds per node', async () => {
    const fake = fakeDocker();
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    fake.on.build = () =>
      new Promise((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        releases.push(() => {
          running -= 1;
          resolve({});
        });
      });
    const deployments = manager(fake, 2);
    for (let i = 0; i < 3; i += 1)
      deployments.deploy(`req-${i}`, payload({ app: { id: generateId('app'), slug: `app${i}` } }));
    await waitFor(() => releases.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(running).toBe(2);
    releases.shift()?.();
    await waitFor(() => releases.length === 2);
    for (const release of releases.splice(0)) release();
    await waitFor(() => releases.length === 0 && results().length === 3);
    expect(peak).toBe(2);
  });

  it('on shutdown fails queued deployments and interrupts running ones after the grace period', async () => {
    const fake = fakeDocker();
    fake.on.up = blockUntilAborted;
    const deployments = manager(fake);
    const app = { id: generateId('app'), slug: 'trail' };
    const running = payload({ app });
    const queued = payload({ app });
    deployments.deploy('req-1', running);
    deployments.deploy('req-2', queued);
    await waitFor(() => fake.calls.some((c) => c.args.includes('up')));
    await deployments.shutdown(20);
    expect(results().map((m) => [m.id, m.payload.outcome])).toEqual([
      ['req-2', 'failed'],
      ['req-1', 'failed'],
    ]);
    expect(
      results().every((m) => m.payload.outcome === 'failed' && m.payload.error.retryable),
    ).toBe(true);
    deployments.deploy('req-3', payload());
    expect(results().at(-1)?.payload).toMatchObject({ outcome: 'failed', error: { code: 'busy' } });
  });

  it('keeps only the newest checkouts of an app', async () => {
    const fake = fakeDocker();
    const deployments = manager(fake);
    const app = { id: generateId('app'), slug: 'trail' };
    const jobs: DeployPayload[] = [];
    for (let i = 0; i < 3; i += 1) {
      jobs.push(payload({ app }));
      // Deployment ids sort by creation time only across milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    for (const [i, job] of jobs.entries()) deployments.deploy(`req-${i}`, job);
    await waitFor(() => results().length === 3 && deployments.activeDeploymentIds().length === 0);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(root, 'apps', app.id))).sort()).toEqual(
      jobs
        .slice(1)
        .map((job) => job.deploymentId)
        .sort(),
    );
  });
});

describe('Semaphore', () => {
  it('lets a waiter leave the queue when its signal aborts', async () => {
    const slots = new Semaphore(1);
    let release = () => {};
    const holder = slots.use(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const waiting = slots.use(() => Promise.resolve('never'), controller.signal);
    controller.abort('cancel');
    await expect(waiting).rejects.toBe('cancel');
    release();
    await holder;
    // The aborted waiter did not take the freed slot.
    await expect(slots.use(() => Promise.resolve('next'))).resolves.toBe('next');
  });
});
