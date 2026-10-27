import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentToServerMessage,
  CHECK_LABEL,
  type CheckRunPayload,
  checkImageName,
  checkProjectName,
  generateId,
  type LogLine,
  parseAgentToServerMessage,
  type ServerToAgentMessage,
} from '@launchway/contracts';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { AgentConnection } from '../../src/connection.js';
import { createAgentRuntime } from '../../src/runtime/agent-runtime.js';

const exec = promisify(execFile);
const logger = pino({ level: process.env.LOG_LEVEL ?? 'silent' });

const suffix = randomBytes(4).toString('hex');
const slug = `itc-${suffix}`;
const appId = generateId('app');
const cloneUrl = 'https://git.example.test/acme/checks-fixture.git';
const TOKEN = 'dGVzdDpjaGVjay10b2tlbi12YWx1ZQ==';
const AUTHORIZATION = `basic ${TOKEN}`;
const LIMITS = { memoryBytes: 256 * 1024 * 1024, cpus: 1, pidsLimit: 256 };

let tmp: string;
let workspace: string;
let bareRepo: string;
const commits: Record<'good' | 'bad' | 'leak' | 'include', string> = {
  good: '',
  bad: '',
  leak: '',
  include: '',
};
/** Stands in for another app's decrypted environment next to the checkout. */
const INCLUDE_MARKER = 'victim-database-password-1f3e';
/** Stands in for the node credential: a file outside the checkout that is no label file. */
const LEAK_MARKER = `lwya_${'L'.repeat(43)}`;
const runIds: string[] = [];
/** A project left by an earlier run of this file's app, for the sweep. */
const leftover = checkProjectName(slug, generateId('chk'));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Launchway Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Launchway Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout.trim();
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

const DOCKERFILE = `FROM alpine:3
RUN adduser -D -u 1234 tester && install -d -o tester -g tester /workspace/.cache
USER tester
WORKDIR /workspace
`;

/** The dev container shape of the Trail repository, in small. */
const COMPOSE = `name: \${COMPOSE_PROJECT_NAME:?set by Launchway}
services:
  dev:
    build:
      context: ..
      dockerfile: .devcontainer/Dockerfile
    command: ["sleep", "infinity"]
    environment:
      GREETING: "hello $$HOME"
    volumes:
      - ..:/workspace
      - cache:/workspace/.cache
    ports: ["8080"]
    container_name: checks-fixture-dev
    depends_on:
      sidecar:
        condition: service_healthy
  sidecar:
    image: busybox
    command: ["httpd", "-f", "-p", "8080", "-h", "/www"]
    volumes:
      - ../config/sidecar.txt:/www/config.txt:ro
    healthcheck:
      test: ["CMD", "test", "-f", "/www/config.txt"]
      interval: 1s
      timeout: 2s
      retries: 30
volumes:
  cache: {}
`;

const BAD_COMPOSE = `services:
  dev:
    image: alpine:3
    volumes:
      - /etc:/host-etc:ro
`;

/** `good`: the fixture project; `bad`: a Compose file that binds a path outside the checkout. */
async function createFixtureRepository(): Promise<void> {
  const src = join(tmp, 'src');
  await mkdir(join(src, '.devcontainer'), { recursive: true });
  await mkdir(join(src, 'config'), { recursive: true });
  await writeFile(join(src, '.devcontainer', 'Dockerfile'), DOCKERFILE);
  await writeFile(join(src, '.devcontainer', 'compose.yaml'), COMPOSE);
  await writeFile(join(src, 'hello.txt'), 'hello from the fixture\n');
  await writeFile(join(src, 'config', 'sidecar.txt'), 'sidecar config costs $5\n');
  await git(src, 'init', '--quiet', '--initial-branch', 'main');
  await git(src, 'add', '.');
  await git(src, 'commit', '--quiet', '-m', 'fixture');
  commits.good = await git(src, 'rev-parse', 'HEAD');
  await writeFile(join(src, '.devcontainer', 'compose.yaml'), BAD_COMPOSE);
  await git(src, 'commit', '--quiet', '-am', 'bind /etc');
  commits.bad = await git(src, 'rev-parse', 'HEAD');
  const credentials = join(tmp, 'credentials.json');
  await writeFile(credentials, `{"nodeId":"node_x","credential":"${LEAK_MARKER}"}\n`);
  await writeFile(
    join(src, '.devcontainer', 'compose.yaml'),
    `services:\n  dev:\n    image: alpine:3\n    label_file: [${credentials}]\n`,
  );
  await git(src, 'commit', '--quiet', '-am', 'label file outside');
  commits.leak = await git(src, 'rev-parse', 'HEAD');
  // Without the YAML preflight, Compose would interpolate leak.yaml with the outside env file.
  const victim = join(tmp, 'victim.env');
  await writeFile(victim, `DATABASE_PASSWORD='${INCLUDE_MARKER}'\n`);
  await writeFile(
    join(src, '.devcontainer', 'leak.yaml'),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, kept literally
    'services:\n  dev:\n    image: alpine:3\n    environment:\n      LEAK: "${DATABASE_PASSWORD:-none}"\n',
  );
  await writeFile(
    join(src, '.devcontainer', 'compose.yaml'),
    `include:\n  - path: leak.yaml\n    env_file: ${victim}\n`,
  );
  await git(src, 'add', '.');
  await git(src, 'commit', '--quiet', '-m', 'include with an env file outside');
  commits.include = await git(src, 'rev-parse', 'HEAD');
  bareRepo = join(tmp, 'fixture.git');
  await git(tmp, 'clone', '--quiet', '--bare', src, bareRepo);
}

interface ControlPlane {
  server: WebSocketServer;
  url: string;
  received: AgentToServerMessage[];
  socket?: WebSocket;
}

async function startControlPlane(): Promise<ControlPlane> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const plane: ControlPlane = {
    server,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/ws`,
    received: [],
  };
  server.on('connection', (socket) => {
    plane.socket = socket;
    socket.on('message', (data) => {
      const parsed = parseAgentToServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`agent sent an invalid message: ${parsed.error}`);
      plane.received.push(parsed.message);
      if (parsed.message.type === 'hello') {
        socket.send(
          JSON.stringify({
            id: parsed.message.id,
            type: 'hello.ok',
            payload: {
              protocolVersion: AGENT_PROTOCOL_VERSION,
              nodeId: generateId('node'),
              serverVersion: 'test',
              heartbeatIntervalMs: 1_000,
            },
          }),
        );
      }
    });
  });
  return plane;
}

let plane: ControlPlane;
let connection: AgentConnection;
let runtime: ReturnType<typeof createAgentRuntime>;

function request(message: ServerToAgentMessage): void {
  if (!plane.socket) throw new Error('agent not connected');
  plane.socket.send(JSON.stringify(message));
}

async function waitFor<T>(
  find: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 240_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = await find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const repliesTo = (id: string) => plane.received.filter((m) => m.id === id);
const logLinesOf = (id: string): LogLine[] =>
  repliesTo(id).flatMap((m) => (m.type === 'check.log' ? m.payload.lines : []));

function checkPayload(
  commit: keyof typeof commits,
  command: string,
  timeoutMs = 120_000,
): CheckRunPayload {
  const runId = generateId('chk');
  runIds.push(runId);
  return {
    runId,
    app: { id: appId, slug },
    source: { cloneUrl, ref: 'main', sha: commits[commit], authorization: AUTHORIZATION },
    composeFiles: ['.devcontainer/compose.yaml'],
    check: { name: 'quality', service: 'dev', command, timeoutMs },
    limits: LIMITS,
  };
}

/** Sends check.run and returns its check.result (after asserting the acknowledgement). */
async function runCheck(id: string, payload: CheckRunPayload) {
  request({ id, type: 'check.run', payload });
  const ack = await waitFor(() => repliesTo(id)[0], 10_000);
  expect(ack).toMatchObject({ type: 'check.log', payload: { runId: payload.runId } });
  if (ack.type === 'check.log') expect(ack.payload.lines[0]?.line).toBe('Received by the node');
  const result = await waitFor(() => repliesTo(id).find((m) => m.type === 'check.result'));
  if (result.type !== 'check.result') throw new Error('expected check.result');
  return result.payload;
}

const labelled = async (kind: 'ps' | 'volume' | 'network' | 'image', filter: string) => {
  const args =
    kind === 'ps'
      ? ['ps', '--all', '--quiet', '--filter', filter]
      : kind === 'image'
        ? ['image', 'ls', '--quiet', '--filter', 'dangling=true', '--filter', filter]
        : [kind, 'ls', '--quiet', '--filter', filter];
  return docker(...args);
};

/** Cleanup runs after the result: waits until nothing of the run is left on Docker or disk. */
async function expectCleanedUp(runId: string): Promise<void> {
  const filter = `label=${CHECK_LABEL}=${runId}`;
  await waitFor(async () => {
    const left = [
      await labelled('ps', filter),
      await labelled('volume', filter),
      await labelled('network', filter),
      await labelled('image', `label=${CHECK_LABEL}=${slug}`),
    ].join('');
    const dir = await stat(join(workspace, 'checks', appId, runId)).then(
      () => true,
      () => false,
    );
    return left === '' && !dir;
  }, 60_000);
  const project = checkProjectName(slug, runId as `chk_${string}`);
  expect(await docker('volume', 'ls', '--quiet', '--filter', `name=${project}`)).toBe('');
}

/** Everything this file may have created; only ever names and labels of its own runs. */
async function cleanupDocker(): Promise<void> {
  for (const runId of runIds) {
    const filter = `label=${CHECK_LABEL}=${runId}`;
    const ids = await docker('ps', '--all', '--quiet', '--filter', filter).catch(() => '');
    if (ids) await docker('rm', '--force', '--volumes', ...ids.split('\n')).catch(() => '');
    const volumes = await docker('volume', 'ls', '--quiet', '--filter', filter).catch(() => '');
    if (volumes) await docker('volume', 'rm', '--force', ...volumes.split('\n')).catch(() => '');
    const project = checkProjectName(slug, runId as `chk_${string}`);
    await docker('volume', 'rm', '--force', `${project}_source`).catch(() => '');
    const networks = await docker('network', 'ls', '--quiet', '--filter', filter).catch(() => '');
    if (networks) await docker('network', 'rm', ...networks.split('\n')).catch(() => '');
  }
  await docker('rm', '--force', `${leftover}-check`).catch(() => '');
  await docker('volume', 'rm', '--force', `${leftover}_source`).catch(() => '');
  await docker('network', 'rm', `${leftover}_default`).catch(() => '');
  await docker('image', 'rm', '--force', checkImageName(slug, 'dev')).catch(() => '');
}

beforeAll(async () => {
  await docker('version', '--format', '{{.Server.Version}}');
  tmp = await mkdtemp(join(tmpdir(), 'launchway-agent-checks-it-'));
  workspace = join(tmp, 'workspace');
  await createFixtureRepository();
  // A run directory left behind by an earlier agent; the sweep removes the whole checks tree.
  await mkdir(join(workspace, 'checks', appId, 'chk_stale'), { recursive: true });
  plane = await startControlPlane();
  runtime = createAgentRuntime({
    logger,
    workspace,
    gitConfig: [
      [`url.file://${bareRepo}.insteadOf`, cloneUrl],
      ['protocol.file.allow', 'always'],
    ],
    trySend: (message) => connection.connected && connection.send(message),
  });
  // Leftovers of an earlier run of this app (same shape as a real run's); the sweep is limited to
  // this file's slug, so it never touches other runs on this Docker.
  const label = `${CHECK_LABEL}=chk_leftover_${suffix}`;
  await docker('volume', 'create', '--label', label, `${leftover}_source`);
  await docker('network', 'create', '--label', label, `${leftover}_default`);
  await docker(
    'container',
    'create',
    '--label',
    label,
    '--label',
    `com.docker.compose.project=${leftover}`,
    '--name',
    `${leftover}-check`,
    'alpine:3',
  );
  runtime.sweepChecks({ slug });
  connection = new AgentConnection({
    url: plane.url,
    logger,
    token: () => `lwya_${'c'.repeat(43)}`,
    hello: async () => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: 'test',
      hostname: 'it-node',
      platform: { os: process.platform, arch: process.arch },
      lanIp: '127.0.0.1',
      docker: null,
      dockerError: null,
    }),
    onHelloOk: async () => {},
    onReady: () => runtime.onConnected(),
    onRequest: (message) => runtime.handle(message),
    activeDeployments: () => runtime.activeDeploymentIds(),
    activeCheckRuns: () => runtime.activeCheckRunIds(),
  });
  connection.start();
  await waitFor(() => connection.connected, 10_000);
});

afterAll(async () => {
  await runtime?.shutdown(5_000);
  await connection?.stop();
  await new Promise<void>((resolve) => (plane ? plane.server.close(() => resolve()) : resolve()));
  await cleanupDocker();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('check runs against Docker', () => {
  it('sweeps leftovers of earlier runs at start', async () => {
    const project = leftover;
    await waitFor(async () => {
      const left = [
        await docker('ps', '--all', '--quiet', '--filter', `name=${project}`),
        await docker('volume', 'ls', '--quiet', '--filter', `name=${project}`),
        await docker('network', 'ls', '--quiet', '--filter', `name=${project}`),
      ].join('');
      const stale = await stat(join(workspace, 'checks', appId, 'chk_stale')).then(
        () => true,
        () => false,
      );
      return left === '' && !stale;
    }, 60_000);
  });

  it('runs a check in the dev container with its sidecar and reports exit 0', async () => {
    const payload = checkPayload(
      'good',
      [
        'set -e',
        'echo stdout-line',
        'echo stderr-line >&2',
        'cat hello.txt',
        'wget -qO- http://sidecar:8080/config.txt',
        'echo written > written.txt && cat written.txt',
        'touch .cache/probe && echo cache-ok',
        'echo "uid=$(id -u)"',
        'env | sort',
      ].join('\n'),
    );
    const result = await runCheck('run-ok', payload);
    const lines = logLinesOf('run-ok');
    const text = (stream: LogLine['stream']) =>
      lines.filter((l) => l.stream === stream).map((l) => l.line);
    if (result.reason !== 'exit' || result.exitCode !== 0) {
      throw new Error(
        `check failed: ${JSON.stringify(result)}\n${lines.map((l) => l.line).join('\n')}`,
      );
    }
    expect(result).toEqual({ runId: payload.runId, reason: 'exit', exitCode: 0 });
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i));
    expect(text('stdout')).toEqual(
      expect.arrayContaining([
        'stdout-line',
        'hello from the fixture',
        // The config reached the sidecar with its `$` intact; the check reads it over the network.
        'sidecar config costs $5',
        // The source volume belongs to the image's user: the check can write to it.
        'written',
        'cache-ok',
        'uid=1234',
        'CI=true',
        `COMPOSE_PROJECT_NAME=${checkProjectName(slug, payload.runId)}`,
        `LAUNCHWAY_APP=${slug}`,
        'LAUNCHWAY_CHECK=1',
        `LAUNCHWAY_CHECK_RUN_ID=${payload.runId}`,
        `LAUNCHWAY_COMMIT_SHA=${commits.good}`,
        'LAUNCHWAY_REF=main',
        'GREETING=hello $HOME',
      ]),
    );
    expect(text('stderr')).toContain('stderr-line');
    expect(text('system')).toContain(`checked out ${commits.good}`);
    const everything = JSON.stringify(plane.received);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('check-token-value');
    expect(
      plane.received.some(
        (m) => m.type === 'heartbeat' && m.payload.activeCheckRunIds?.includes(payload.runId),
      ),
    ).toBe(true);
    expect(runtime.activeCheckRunIds()).toEqual([]);
    await expectCleanedUp(payload.runId);
  });

  it('reports a failing command with its exit code', async () => {
    const payload = checkPayload('good', 'echo failing; exit 3');
    const result = await runCheck('run-exit-3', payload);
    expect(result).toEqual({
      runId: payload.runId,
      reason: 'exit',
      exitCode: 3,
      message: 'Exited with code 3',
    });
    expect(logLinesOf('run-exit-3').some((l) => l.line === 'failing')).toBe(true);
    await expectCleanedUp(payload.runId);
  });

  it('stops a command that runs past its time limit', async () => {
    const payload = checkPayload('good', 'echo started; sleep 60', 3_000);
    const started = Date.now();
    const result = await runCheck('run-timeout', payload);
    expect(result).toEqual({
      runId: payload.runId,
      reason: 'timeout',
      exitCode: null,
      message: 'Timed out after 3 seconds',
    });
    expect(Date.now() - started).toBeLessThan(60_000);
    await expectCleanedUp(payload.runId);
  });

  it('cancels a running check and kills its container', async () => {
    const payload = checkPayload('good', 'echo started; sleep 60');
    request({ id: 'run-cancel', type: 'check.run', payload });
    await waitFor(() => logLinesOf('run-cancel').some((l) => l.line === 'started'));
    request({ id: 'cancel-1', type: 'check.cancel', payload: { runId: payload.runId } });
    const result = await waitFor(
      () => repliesTo('run-cancel').find((m) => m.type === 'check.result'),
      10_000,
    );
    expect(result.payload).toEqual({ runId: payload.runId, reason: 'cancelled', exitCode: null });
    expect(repliesTo('cancel-1')).toEqual([]);
    await expectCleanedUp(payload.runId);
  });

  it('refuses a Compose file that binds a path outside the repository', async () => {
    const payload = checkPayload('bad', 'true');
    const result = await runCheck('run-policy', payload);
    expect(result).toMatchObject({ runId: payload.runId, reason: 'policy', exitCode: null });
    expect(result.message).toMatch(
      /bind mount "\/etc" is not allowed: checks only bind-mount paths inside the repository/,
    );
    await expectCleanedUp(payload.runId);
  });

  it('refuses a label file outside the repository before Compose reads it', async () => {
    // Compose reads label files while loading the project and quotes them in parse errors.
    const payload = checkPayload('leak', 'true');
    const result = await runCheck('run-leak', payload);
    expect(result).toMatchObject({ runId: payload.runId, reason: 'policy', exitCode: null });
    expect(result.message).toMatch(
      /^\.devcontainer\/compose\.yaml: service "dev" label_file ".*credentials\.json" must be a relative path inside the repository$/,
    );
    expect(logLinesOf('run-leak').some((l) => l.line.includes('docker compose'))).toBe(false);
    expect(JSON.stringify(plane.received)).not.toContain(LEAK_MARKER);
    await expectCleanedUp(payload.runId);
  });

  it('refuses a Compose file that includes a file outside the repository', async () => {
    const payload = checkPayload('include', 'env');
    const result = await runCheck('run-include', payload);
    expect(result).toEqual({
      runId: payload.runId,
      reason: 'policy',
      exitCode: null,
      message:
        ".devcontainer/compose.yaml: checks do not support include; list the files in the check's Compose files",
    });
    expect(JSON.stringify(plane.received)).not.toContain(INCLUDE_MARKER);
    await expectCleanedUp(payload.runId);
  });

  it('answers a cancel of an unknown run with not-found', async () => {
    request({ id: 'cancel-unknown', type: 'check.cancel', payload: { runId: generateId('chk') } });
    const reply = await waitFor(() => repliesTo('cancel-unknown')[0], 10_000);
    expect(reply).toMatchObject({ type: 'error', payload: { code: 'not-found' } });
  });
});
