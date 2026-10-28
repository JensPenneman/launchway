import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkProjectName, DEFAULT_PROXY_NETWORK, generateId } from '@launchway/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCheckDocument,
  checkEnvironment,
  checkSourcePaths,
} from '../../src/runtime/check-document.js';
import { probeSources } from '../../src/runtime/check-sources.js';
import { composeArgs } from '../../src/runtime/compose.js';
import { formatEnvFile } from '../../src/runtime/compose-files.js';
import { evaluateComposePolicy, parseComposeConfig } from '../../src/runtime/compose-policy.js';
import { preflightComposeFiles } from '../../src/runtime/compose-preflight.js';
import { isInsideReal, Workspace } from '../../src/runtime/workspace.js';

const exec = promisify(execFile);

/**
 * Trail's development container as its repository has it (`.devcontainer/compose.yaml`, and
 * `compose.web.yaml`, which publishes Vite's port on the host's loopback).
 */
const FIXTURE = fileURLToPath(new URL('../fixtures/trail', import.meta.url));
const COMPOSE_FILES = ['.devcontainer/compose.yaml', '.devcontainer/compose.web.yaml'];

let tmp: string;

async function composeConfig(args: string[], cwd: string) {
  const { stdout } = await exec('docker', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  const config = parseComposeConfig(stdout);
  if (!config) throw new Error('docker compose config printed no project');
  return config;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'launchway-check-ports-'));
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("a check of Trail's development container", () => {
  it('publishes no host ports, so runs of one app at once never collide (ADR 0021)', async () => {
    const root = join(tmp, 'src');
    await cp(FIXTURE, root, { recursive: true });
    const runId = generateId('chk');
    const app = { id: generateId('app'), slug: 'trail' };
    const project = checkProjectName(app.slug, runId);
    const workspace = new Workspace(join(tmp, 'workspace'));
    const resolved = await workspace.resolveComposeFiles(root, COMPOSE_FILES);
    await preflightComposeFiles({ ...resolved, mode: 'check' });
    const env = checkEnvironment(
      {
        runId,
        app,
        source: {
          cloneUrl: 'https://github.com/JensPenneman/trail.git',
          ref: 'main',
          sha: '3f786850e387550fdab836ed7e6dc881de23001b',
          authorization: null,
        },
      },
      project,
    );
    const envFile = join(tmp, 'check.env');
    await writeFile(envFile, formatEnvFile(env), { mode: 0o600 });

    // Read by the real Compose CLI, as the agent reads it.
    const target = { project, files: resolved.files, projectDir: resolved.projectDir, envFile };
    const config = await composeConfig(
      composeArgs(target, 'config', '--format', 'json', '--no-env-resolution'),
      resolved.projectDir,
    );
    expect(config.services.dev?.ports).toEqual([
      expect.objectContaining({ host_ip: '127.0.0.1', target: 5173 }),
    ]);

    const sources = await probeSources(
      resolved.root,
      checkSourcePaths(config, resolved.projectDir),
    );
    const policy = evaluateComposePolicy(config, {
      mode: 'check',
      projectName: project,
      proxyNetwork: DEFAULT_PROXY_NETWORK,
      routes: [],
      isInsideCheckout: (path) => isInsideReal(resolved.root, path),
      projectDir: resolved.projectDir,
      workspaceRoot: workspace.root,
      fileSize: (path) => {
        const source = sources.get(path);
        return source?.kind === 'file' ? source.size : null;
      },
    });
    expect(policy.violations).toEqual([]);
    expect(policy.ports).toEqual([]);
    const built = buildCheckDocument(config, {
      project,
      appId: app.id,
      slug: app.slug,
      runId,
      service: 'dev',
      env,
      limits: { memoryBytes: 2048 * 1024 ** 2, cpus: 2, pidsLimit: 4096 },
      projectDir: resolved.projectDir,
      sources: (path) => sources.get(path),
    });
    const services = built.document.services as Record<string, Record<string, unknown>>;
    expect(Object.keys(services).sort()).toEqual(['db', 'dev']);
    for (const service of Object.values(services)) expect(service).not.toHaveProperty('ports');

    // The document the run uses, read back by Compose: still nothing published.
    const documentPath = join(tmp, 'compose.json');
    await writeFile(documentPath, JSON.stringify(built.document), { mode: 0o600 });
    const reread = await composeConfig(
      composeArgs({ project, files: [documentPath], envFile }, 'config', '--format', 'json'),
      tmp,
    );
    for (const service of Object.values(reread.services)) expect(service.ports ?? []).toEqual([]);
  });
});
