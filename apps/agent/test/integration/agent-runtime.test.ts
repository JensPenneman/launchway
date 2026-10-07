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
  type DeployPayload,
  generateId,
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
const slug = `it-${suffix}`;
const project = `launchway-${slug}`;
const proxyNetwork = `launchway-it-proxy-${suffix}`;
const appId = generateId('app');
const cloneUrl = 'https://git.example.test/acme/fixture.git';

let tmp: string;
let workspace: string;
let bareRepo: string;
const commits: Record<string, string> = {};

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

const COMPOSE = `services:
  web:
    image: traefik/whoami
    command: ["--port", "8080"]
    environment:
      GREETING: \${GREETING}
    volumes:
      - data:/data
  worker:
    build:
      context: ./worker
    command: ["--port", "9000"]
volumes:
  data: {}
`;

const BAD_COMPOSE = `services:
  web:
    image: traefik/whoami
    volumes:
      - /etc:/host-etc:ro
`;

/** A tiny repository: v1.0.0 deploys fine, v2.0.0-bad violates the Compose policy. */
async function createFixtureRepository(): Promise<void> {
  const src = join(tmp, 'src');
  await mkdir(join(src, 'worker'), { recursive: true });
  await writeFile(join(src, 'compose.yaml'), COMPOSE);
  await writeFile(
    join(src, 'worker', 'Dockerfile'),
    'FROM traefik/whoami\nLABEL org.example.fixture="1"\n',
  );
  await git(src, 'init', '--quiet', '--initial-branch', 'main');
  await git(src, 'add', '.');
  await git(src, 'commit', '--quiet', '-m', 'fixture');
  await git(src, 'tag', 'v1.0.0');
  commits['v1.0.0'] = await git(src, 'rev-parse', 'HEAD');
  await writeFile(join(src, 'compose.yaml'), BAD_COMPOSE);
  await git(src, 'commit', '--quiet', '-am', 'bind mount');
  await git(src, 'tag', 'v2.0.0-bad');
  commits['v2.0.0-bad'] = await git(src, 'rev-parse', 'HEAD');
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
              heartbeatIntervalMs: 60_000,
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

async function waitFor<T>(find: () => T | undefined, timeoutMs = 240_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the agent');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const repliesTo = (id: string) => plane.received.filter((m) => m.id === id);

function deployPayload(ref: string): DeployPayload {
  const commitSha = commits[ref];
  if (!commitSha) throw new Error(`unknown ref ${ref}`);
  return {
    deploymentId: generateId('dep'),
    app: { id: appId, slug },
    source: { cloneUrl, ref, commitSha, authorization: 'basic dGVzdDp0ZXN0LXRva2VuLXZhbHVl' },
    build: { kind: 'compose', composeFiles: ['compose.yaml'] },
    env: { GREETING: "hello 'world' $HOME" },
    routes: [{ service: 'web', port: 8080, alias: `${slug}-web` }],
    attach: [{ service: 'web', alias: `${slug}-web` }],
    network: { proxyNetwork, publishOnIp: '127.0.0.1' },
  };
}

async function cleanupDocker(): Promise<void> {
  await exec(
    'docker',
    ['compose', '-p', project, 'down', '--volumes', '--remove-orphans', '--timeout', '1'],
    {
      cwd: tmpdir(),
    },
  ).catch(() => undefined);
  await exec('docker', ['network', 'rm', proxyNetwork]).catch(() => undefined);
  await exec('docker', ['image', 'rm', '--force', `${project}-worker`]).catch(() => undefined);
}

beforeAll(async () => {
  await docker('version', '--format', '{{.Server.Version}}');
  tmp = await mkdtemp(join(tmpdir(), 'launchway-agent-it-'));
  workspace = join(tmp, 'workspace');
  await createFixtureRepository();
  plane = await startControlPlane();
  runtime = createAgentRuntime({
    logger,
    workspace,
    // Clone over file:// in place of https; everything else is the production path.
    gitConfig: [
      [`url.file://${bareRepo}.insteadOf`, cloneUrl],
      ['protocol.file.allow', 'always'],
    ],
    trySend: (message) => connection.connected && connection.send(message),
  });
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
  });
  connection.start();
  await waitFor(() => connection.connected, 10_000);
});

afterAll(async () => {
  await runtime?.shutdown(1_000);
  await connection?.stop();
  await new Promise<void>((resolve) => (plane ? plane.server.close(() => resolve()) : resolve()));
  await cleanupDocker();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('agent runtime against Docker', () => {
  it('deploys a tag, reports progress, logs and published ports', async () => {
    const payload = deployPayload('v1.0.0');
    request({ id: 'deploy-1', type: 'deploy', payload });
    const result = await waitFor(() =>
      repliesTo('deploy-1').find((m) => m.type === 'deployment.result'),
    );
    const replies = repliesTo('deploy-1');
    const logLines = replies.flatMap((m) => (m.type === 'deployment.log' ? m.payload.lines : []));
    if (result.type !== 'deployment.result' || result.payload.outcome !== 'succeeded') {
      throw new Error(
        `deployment failed: ${JSON.stringify(result.payload)}\n${logLines.map((l) => l.line).join('\n')}`,
      );
    }

    const progress = replies.flatMap((m) =>
      m.type === 'deployment.progress' ? [m.payload.status] : [],
    );
    expect([...new Set(progress)]).toEqual(['cloning', 'building', 'starting']);
    expect(logLines.map((l) => l.seq)).toEqual(logLines.map((_, i) => i));
    expect(logLines.some((l) => l.stream === 'system' && l.line.startsWith('$ git clone'))).toBe(
      true,
    );
    expect(logLines.some((l) => l.line.includes(`checked out ${payload.source.commitSha}`))).toBe(
      true,
    );
    const everything = JSON.stringify(plane.received);
    expect(everything).not.toContain('dGVzdDp0ZXN0LXRva2VuLXZhbHVl');
    expect(everything).not.toContain("hello 'world'");

    const services = result.payload.services;
    expect(services.map((s) => [s.service, s.state])).toEqual([
      ['web', 'running'],
      ['worker', 'running'],
    ]);
    const web = services.find((s) => s.service === 'web');
    const published = web?.publishedPorts.find((p) => p.containerPort === 8080);
    expect(published).toMatchObject({ hostIp: '127.0.0.1', protocol: 'tcp' });
    expect(published?.hostPort).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${published?.hostPort}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hostname');

    // Labels, environment and the proxy network alias on the running container.
    const inspect = JSON.parse(await docker('inspect', web?.containerId ?? '')) as {
      Config: { Env: string[]; Labels: Record<string, string> };
      NetworkSettings: {
        Networks: Record<string, { Aliases: string[] | null; DNSNames?: string[] | null }>;
      };
    }[];
    const container = inspect[0];
    expect(container?.Config.Env).toContain("GREETING=hello 'world' $HOME");
    expect(container?.Config.Labels).toMatchObject({
      'launchway.app': appId,
      'launchway.deployment': payload.deploymentId,
      'launchway.service': 'web',
    });
    const proxy = container?.NetworkSettings.Networks[proxyNetwork];
    expect([...(proxy?.Aliases ?? []), ...(proxy?.DNSNames ?? [])]).toContain(`${slug}-web`);
    expect(container?.NetworkSettings.Networks[`${project}_default`]).toBeDefined();

    const envFile = await stat(join(workspace, 'apps', appId, payload.deploymentId, '.env'));
    expect(envFile.mode & 0o777).toBe(0o600);
  });

  it('rejects a ref whose Compose file violates the policy', async () => {
    request({ id: 'deploy-bad', type: 'deploy', payload: deployPayload('v2.0.0-bad') });
    const result = await waitFor(() =>
      repliesTo('deploy-bad').find((m) => m.type === 'deployment.result'),
    );
    expect(result.payload).toMatchObject({
      outcome: 'failed',
      error: { code: 'policy-violation', retryable: false },
    });
    if (result.type === 'deployment.result' && result.payload.outcome === 'failed') {
      expect(result.payload.error.message).toMatch(/host bind mount "\/etc"/);
    }
  });

  it('answers status', async () => {
    request({ id: 'status-1', type: 'status', payload: { appId, slug } });
    const reply = await waitFor(() => repliesTo('status-1').find((m) => m.type === 'app.status'));
    expect(reply.payload).toMatchObject({ appId });
    if (reply.type !== 'app.status') throw new Error('expected app.status');
    expect(reply.payload.services.map((s) => s.state)).toEqual(['running', 'running']);
  });

  it('streams logs until stopped, and completes without follow', async () => {
    request({
      id: 'logs-1',
      type: 'logs.start',
      payload: { appId, slug, service: 'web', follow: true, tail: 50 },
    });
    const chunk = await waitFor(() => repliesTo('logs-1').find((m) => m.type === 'logs.chunk'));
    if (chunk.type !== 'logs.chunk') throw new Error('expected logs.chunk');
    expect(chunk.payload.lines.some((l) => l.service === 'web' && l.line.includes('8080'))).toBe(
      true,
    );
    request({ id: 'logs-stop-1', type: 'logs.stop', payload: { streamId: 'logs-1' } });
    const end = await waitFor(() => repliesTo('logs-1').find((m) => m.type === 'logs.end'), 20_000);
    expect(end.payload).toEqual({ reason: 'stopped' });

    request({
      id: 'logs-2',
      type: 'logs.start',
      payload: { appId, slug, follow: false, tail: 10 },
    });
    const completed = await waitFor(
      () => repliesTo('logs-2').find((m) => m.type === 'logs.end'),
      30_000,
    );
    expect(completed.payload).toEqual({ reason: 'completed' });
    const services = new Set(
      repliesTo('logs-2').flatMap((m) =>
        m.type === 'logs.chunk' ? m.payload.lines.map((l) => l.service) : [],
      ),
    );
    expect([...services].sort()).toEqual(['web', 'worker']);
  });

  it('stops the app', async () => {
    request({ id: 'stop-1', type: 'stop', payload: { appId, slug } });
    const reply = await waitFor(
      () => repliesTo('stop-1').find((m) => m.type === 'app.status'),
      120_000,
    );
    if (reply.type !== 'app.status') throw new Error('expected app.status');
    expect(reply.payload.services.map((s) => s.state)).toEqual(['exited', 'exited']);
  });

  it('removes the app, its volumes and its checkouts', async () => {
    request({ id: 'remove-1', type: 'remove', payload: { appId, slug, removeVolumes: true } });
    const reply = await waitFor(
      () => repliesTo('remove-1').find((m) => m.type === 'app.status'),
      120_000,
    );
    expect(reply.payload).toEqual({ appId, services: [] });
    expect(
      await docker(
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ),
    ).toBe('');
    expect(
      await docker(
        'volume',
        'ls',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ),
    ).toBe('');
    await expect(stat(join(workspace, 'apps', appId))).rejects.toThrow();
    expect(repliesTo('remove-1').some((m) => m.type === 'error')).toBe(false);
  });
});
