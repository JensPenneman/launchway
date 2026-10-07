import {
  type AppId,
  DEPLOYMENT_STATUSES,
  type DeploymentId,
  type DeploymentStatus,
  generateId,
} from '@launchway/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDeps } from '../../../test/support/deps.js';
import type { Deps } from '../../deps.js';
import {
  createDeploymentsMirror,
  githubDeploymentState,
  githubEnvironment,
  type MirrorSnapshot,
  type MirrorStore,
} from './deployments-mirror.js';
import type { OctokitLike, OctokitResponse } from './octokit.js';
import type { ConnectionRow } from './providers.js';
import { githubConnectionState } from './state.js';

interface Call {
  route: string;
  params: Record<string, unknown>;
}

type Handler = (call: Call) => OctokitResponse | Promise<OctokitResponse>;

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });
}

/** Stand-in for Octokit: records requests and answers through `handler`. */
class FakeOctokit implements OctokitLike {
  readonly calls: Call[] = [];
  nextId = 1000;
  handler: Handler = (call) =>
    call.route === 'POST /repos/{owner}/{repo}/deployments'
      ? { status: 201, data: { id: this.nextId++ }, headers: {} }
      : { status: 201, data: { id: 1 }, headers: {} };

  async request(route: string, params: Record<string, unknown> = {}) {
    const { request: _options, ...rest } = params;
    const call = { route, params: rest };
    this.calls.push(call);
    return this.handler(call);
  }

  routes() {
    return this.calls.map((call) => call.route.split(' ')[1]?.split('/').at(-1));
  }

  statuses() {
    return this.calls
      .filter((call) => call.route.endsWith('/statuses'))
      .map((call) => call.params.state);
  }
}

const connection = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id: generateId('gh'),
  kind: 'app',
  name: 'Launchway',
  accountLogin: 'octo',
  accountType: 'User',
  appId: 42,
  appSlug: 'launchway',
  appHtmlUrl: null,
  clientId: null,
  clientSecretEncrypted: null,
  privateKeyEncrypted: 'x',
  webhookSecretEncrypted: 'x',
  installationId: 7,
  tokenEncrypted: null,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

class MemoryStore implements MirrorStore {
  readonly snapshots = new Map<DeploymentId, MirrorSnapshot>();
  readonly saved: [DeploymentId, number][] = [];

  add(
    status: DeploymentStatus,
    overrides: { conn?: ConnectionRow; environmentName?: string | null; optOut?: boolean } = {},
  ): DeploymentId {
    const id = generateId('dep');
    this.snapshots.set(id, {
      deployment: {
        id,
        appId: 'app_01' as AppId,
        commitSha: 'a'.repeat(40),
        status,
        statusMessage: null,
        githubDeploymentId: null,
        environmentName: overrides.environmentName ?? null,
      },
      app: { repoOwner: 'octo', repoName: 'trail', githubDeployments: !overrides.optOut },
      connection: overrides.conn ?? connection(),
      environmentUrl: 'https://trail.example.com',
      publicUrl: 'https://deploy.example.com',
    });
    return id;
  }

  set(id: DeploymentId, status: DeploymentStatus, statusMessage: string | null = null) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error('unknown');
    this.snapshots.set(id, {
      ...snapshot,
      deployment: { ...snapshot.deployment, status, statusMessage },
    });
  }

  async load(id: DeploymentId) {
    return this.snapshots.get(id) ?? null;
  }

  async saveGitHubDeploymentId(id: DeploymentId, githubDeploymentId: number) {
    this.saved.push([id, githubDeploymentId]);
    const snapshot = this.snapshots.get(id);
    if (snapshot && snapshot.deployment.githubDeploymentId === null) {
      this.snapshots.set(id, {
        ...snapshot,
        deployment: { ...snapshot.deployment, githubDeploymentId },
      });
    }
  }
}

describe('state mapping', () => {
  it('maps every Launchway status', () => {
    const mapped = Object.fromEntries(
      DEPLOYMENT_STATUSES.map((s) => [s, githubDeploymentState(s)]),
    );
    expect(mapped).toEqual({
      queued: null,
      cloning: 'in_progress',
      building: 'in_progress',
      starting: 'in_progress',
      running: 'success',
      superseded: 'inactive',
      stopped: 'inactive',
      failed: 'failure',
      cancelled: 'error',
    });
  });

  it('uses production unless the deployment names a preview environment', () => {
    expect(githubEnvironment(null)).toEqual({
      environment: 'production',
      transientEnvironment: false,
      productionEnvironment: true,
    });
    expect(githubEnvironment('preview/pr-12')).toEqual({
      environment: 'preview/pr-12',
      transientEnvironment: true,
      productionEnvironment: false,
    });
  });
});

describe('deployments mirror', () => {
  let deps: Deps;
  let store: MemoryStore;
  let octokit: FakeOctokit;
  let clock: number;
  let slept: number[];
  let mirror: ReturnType<typeof createDeploymentsMirror>;

  beforeEach(() => {
    deps = createTestDeps();
    store = new MemoryStore();
    octokit = new FakeOctokit();
    clock = Date.parse('2026-10-07T10:00:00Z');
    slept = [];
    mirror = createDeploymentsMirror(deps, {
      store,
      octokitFor: async () => octokit,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
  });

  it('creates the GitHub deployment and follows the status to success', async () => {
    const id = store.add('queued');
    expect(await mirror.sync(id, true)).toBe('created');
    expect(octokit.calls).toHaveLength(1);
    expect(octokit.calls[0]).toEqual({
      route: 'POST /repos/{owner}/{repo}/deployments',
      params: {
        owner: 'octo',
        repo: 'trail',
        ref: 'a'.repeat(40),
        task: 'deploy',
        auto_merge: false,
        required_contexts: [],
        environment: 'production',
        transient_environment: false,
        production_environment: true,
        description: `Launchway deployment ${id}`,
        payload: { launchway: { deploymentId: id, appId: 'app_01' } },
      },
    });
    expect(store.saved).toEqual([[id, 1000]]);

    store.set(id, 'building');
    expect(await mirror.sync(id, false)).toBe('updated');
    store.set(id, 'running');
    expect(await mirror.sync(id, false)).toBe('updated');
    expect(octokit.statuses()).toEqual(['in_progress', 'success']);
    expect(octokit.calls.at(-1)?.params).toEqual({
      owner: 'octo',
      repo: 'trail',
      deployment_id: 1000,
      state: 'success',
      description: 'Running',
      log_url: `https://deploy.example.com/apps/app_01?deployment=${id}`,
      environment_url: 'https://trail.example.com',
    });
  });

  it('marks previews as transient and maps failure, cancel and supersede', async () => {
    const preview = store.add('cloning', { environmentName: 'preview/pr-7' });
    await mirror.sync(preview, true);
    expect(octokit.calls[0]?.params).toMatchObject({
      environment: 'preview/pr-7',
      transient_environment: true,
      production_environment: false,
    });
    store.set(preview, 'failed', 'compose up exited with 1');
    await mirror.sync(preview, false);
    expect(octokit.calls.at(-1)?.params).toMatchObject({
      state: 'failure',
      description: 'Failed: compose up exited with 1',
    });
    expect(octokit.calls.at(-1)?.params).not.toHaveProperty('environment_url');

    const cancelled = store.add('building');
    await mirror.sync(cancelled, true);
    store.set(cancelled, 'cancelled');
    await mirror.sync(cancelled, false);
    const superseded = store.add('running');
    await mirror.sync(superseded, true);
    store.set(superseded, 'superseded');
    await mirror.sync(superseded, false);
    expect(octokit.statuses()).toEqual([
      'in_progress',
      'failure',
      'in_progress',
      'error',
      'success',
      'inactive',
    ]);
  });

  it('is idempotent: one GitHub deployment, no repeated statuses', async () => {
    const id = store.add('starting');
    await Promise.all([mirror.schedule(id, true), mirror.schedule(id, false)]);
    await mirror.schedule(id, false);
    expect(await mirror.sync(id, true)).toBe('unchanged');
    expect(store.saved).toHaveLength(1);
    expect(octokit.routes()).toEqual(['deployments', 'statuses']);
  });

  it('coalesces bursts of events into the latest state', async () => {
    const id = store.add('queued');
    const first = mirror.schedule(id, true);
    store.set(id, 'building');
    void mirror.schedule(id, false);
    store.set(id, 'running');
    void mirror.schedule(id, false);
    await first;
    await mirror.idle();
    expect(octokit.statuses()).toEqual(['success']);
  });

  it('does not backfill deployments that finished before mirroring', async () => {
    const id = store.add('running');
    expect(await mirror.sync(id, false)).toBe('skipped');
    expect(octokit.calls).toHaveLength(0);
  });

  it('respects the per-app opt-out', async () => {
    const id = store.add('queued', { optOut: true });
    expect(await mirror.sync(id, true)).toBe('skipped');
    expect(octokit.calls).toHaveLength(0);
  });

  it('turns 403 into a capability hint, logged and announced once per hour', async () => {
    const conn = connection();
    octokit.handler = () => {
      throw httpError(403, { 'x-ratelimit-remaining': '4999' });
    };
    const events: unknown[] = [];
    deps.events.subscribe((event) => events.push(event));
    const first = store.add('queued', { conn });
    expect(await mirror.sync(first, true)).toBe('denied');
    expect(slept).toEqual([]); // a permission error is not retried
    const state = githubConnectionState(deps.events);
    expect(state.denials.get(conn.id)).toEqual({ at: clock, status: 403 });
    expect(events).toEqual([
      expect.objectContaining({ topic: 'github', action: 'updated', resourceId: conn.id }),
    ]);

    // Within the pause no request is made at all.
    const second = store.add('queued', { conn });
    expect(await mirror.sync(second, true)).toBe('denied');
    expect(octokit.calls).toHaveLength(1);

    // Later attempts try again but do not announce again within the hour.
    clock += 10 * 60 * 1000;
    expect(await mirror.sync(second, true)).toBe('denied');
    expect(octokit.calls).toHaveLength(2);
    expect(events).toHaveLength(1);

    clock += 60 * 60 * 1000;
    await mirror.sync(second, true);
    expect(events).toHaveLength(2);

    // Granted: the next success clears the denial.
    octokit.handler = () => ({ status: 201, data: { id: 5 }, headers: {} });
    clock += 10 * 60 * 1000;
    expect(await mirror.sync(second, true)).toBe('created');
    expect(state.denials.has(conn.id)).toBe(false);
  });

  it('never fails on other GitHub errors', async () => {
    octokit.handler = () => {
      throw httpError(422, {});
    };
    const id = store.add('queued');
    expect(await mirror.sync(id, true)).toBe('failed');
    octokit.handler = () => {
      throw new Error('socket hang up');
    };
    expect(await mirror.sync(id, true)).toBe('failed');
    // A later in-progress event creates it once GitHub answers again.
    octokit.handler = () => ({ status: 201, data: { id: 9 }, headers: {} });
    store.set(id, 'cloning');
    expect(await mirror.sync(id, false)).toBe('created');
  });

  it('retries rate-limited requests with backoff, at most 3 times', async () => {
    let failures = 2;
    octokit.handler = () => {
      if (failures > 0) {
        failures -= 1;
        throw httpError(429, { 'retry-after': '2' });
      }
      return { status: 201, data: { id: 11 }, headers: {} };
    };
    const id = store.add('queued');
    expect(await mirror.sync(id, true)).toBe('created');
    expect(slept).toEqual([2000, 2000]);

    slept = [];
    octokit.handler = () => {
      throw httpError(403, { 'x-ratelimit-remaining': '0' });
    };
    const other = store.add('queued');
    expect(await mirror.sync(other, true)).toBe('failed');
    expect(slept).toHaveLength(3);
    expect(githubConnectionState(deps.events).denials.size).toBe(0);
  });

  it('stops updating a GitHub deployment that was deleted there', async () => {
    const id = store.add('cloning');
    await mirror.sync(id, true);
    octokit.handler = () => {
      throw httpError(404);
    };
    store.set(id, 'running');
    expect(await mirror.sync(id, false)).toBe('skipped');
    expect(githubConnectionState(deps.events).denials.size).toBe(0);
  });

  it('follows deployment change events', async () => {
    mirror.start();
    const id = store.add('queued');
    deps.events.publish({ topic: 'deployments', action: 'created', resourceId: id, data: {} });
    await mirror.idle();
    store.set(id, 'running');
    deps.events.publish({
      topic: 'deployments',
      action: 'updated',
      resourceId: id,
      data: { status: 'running' },
    });
    // Service health updates and other topics are ignored.
    deps.events.publish({
      topic: 'deployments',
      action: 'updated',
      resourceId: id,
      data: { services: true },
    });
    deps.events.publish({ topic: 'apps', action: 'updated', resourceId: 'app_01' });
    await mirror.idle();
    expect(octokit.routes()).toEqual(['deployments', 'statuses']);
    deps.lifecycle.beginShutdown();
  });
});
