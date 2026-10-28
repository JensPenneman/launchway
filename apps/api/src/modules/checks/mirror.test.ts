import {
  type AppId,
  type CheckRunId,
  type CheckRunStatus,
  type GitHubCommitStatusState,
  generateId,
  type PlatformEvent,
} from '@launchway/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDeps } from '../../../test/support/deps.js';
import type { Deps } from '../../deps.js';
import type { OctokitLike, OctokitResponse } from '../github/octokit.js';
import type { ConnectionRow } from '../github/providers.js';
import { DENIAL_PAUSE_MS, githubConnectionState } from '../github/state.js';
import {
  checkTargetUrl,
  commitStatusOf,
  createChecksMirror,
  formatDuration,
  type StatusRun,
  type StatusSnapshot,
  type StatusStore,
} from './mirror.js';

const STARTED = new Date('2026-10-27T10:00:00.000Z');

function runOf(fields: Partial<StatusRun> = {}): StatusRun {
  return {
    id: 'chk_01' as CheckRunId,
    appId: 'app_01' as AppId,
    name: 'quality',
    commitSha: 'a'.repeat(40),
    status: 'queued',
    reason: null,
    exitCode: null,
    statusMessage: null,
    timeoutMinutes: 30,
    githubState: null,
    createdAt: new Date(STARTED.getTime() - 5_000),
    startedAt: null,
    finishedAt: null,
    ...fields,
  };
}

const finished = (seconds: number) => ({
  startedAt: STARTED,
  finishedAt: new Date(STARTED.getTime() + seconds * 1000),
});

describe('commitStatusOf', () => {
  it('reports queued and running runs as pending', () => {
    expect(commitStatusOf(runOf())).toEqual({ state: 'pending', description: 'Queued' });
    expect(commitStatusOf(runOf({ status: 'running', startedAt: STARTED }))).toEqual({
      state: 'pending',
      description: 'Running',
    });
  });

  it('reports the verdict with the duration of the run', () => {
    expect(
      commitStatusOf(runOf({ status: 'succeeded', reason: 'exit', exitCode: 0, ...finished(65) })),
    ).toEqual({ state: 'success', description: 'Passed in 1m 5s' });
    expect(
      commitStatusOf(runOf({ status: 'failed', reason: 'exit', exitCode: 2, ...finished(30) })),
    ).toEqual({ state: 'failure', description: 'Failed: exit code 2 after 30s' });
    expect(
      commitStatusOf(runOf({ status: 'failed', reason: 'timeout', ...finished(1800) })),
    ).toEqual({ state: 'failure', description: 'Timed out after 30 minutes' });
  });

  it('reports errors with the first line of their message', () => {
    const run = runOf({
      status: 'errored',
      reason: 'build',
      statusMessage: 'Building the dev service failed\n--- last log lines ---\nERROR: boom',
      ...finished(12),
    });
    expect(commitStatusOf(run)).toEqual({
      state: 'error',
      description: 'Error: Building the dev service failed',
    });
    expect(commitStatusOf(runOf({ status: 'errored', reason: 'lost' })).description).toBe(
      'Error: lost',
    );
  });

  it('says why a run was not queued', () => {
    const message =
      "Not run: 28 queued and 5 new checks would exceed the app's limit of 30; run it again later";
    expect(
      commitStatusOf(runOf({ status: 'errored', reason: 'queue-full', statusMessage: message })),
    ).toEqual({ state: 'error', description: message });
  });

  it("gives a same-tree copy the verdict of the run it copied, and a closed pull request's runs a reason", () => {
    const message = 'Same tree as 3f78685, passed in 4m 18s';
    expect(
      commitStatusOf(runOf({ status: 'succeeded', reason: 'same-tree', statusMessage: message })),
    ).toEqual({ state: 'success', description: message });
    const failed = 'Same tree as 3f78685, failed: exit code 1 after 52s';
    expect(
      commitStatusOf(runOf({ status: 'failed', reason: 'same-tree', statusMessage: failed })),
    ).toEqual({ state: 'failure', description: failed });
    expect(
      commitStatusOf(
        runOf({
          status: 'cancelled',
          reason: 'closed',
          statusMessage: 'Cancelled: pull request #12 was merged',
        }),
      ),
    ).toEqual({ state: 'error', description: 'Pull request closed' });
  });

  it('tells a superseded run from a cancelled one', () => {
    expect(
      commitStatusOf(
        runOf({ status: 'cancelled', reason: 'superseded', statusMessage: 'Superseded by abc' }),
      ),
    ).toEqual({ state: 'error', description: 'Superseded by a newer commit' });
    expect(commitStatusOf(runOf({ status: 'cancelled', reason: 'cancelled' }))).toEqual({
      state: 'error',
      description: 'Cancelled',
    });
  });

  it('keeps descriptions within 140 characters', () => {
    const run = runOf({ status: 'errored', reason: 'policy', statusMessage: 'x'.repeat(300) });
    const { description } = commitStatusOf(run);
    expect(description).toHaveLength(140);
    expect(description.endsWith('...')).toBe(true);
  });
});

describe('formatDuration and checkTargetUrl', () => {
  it('formats seconds, minutes and hours', () => {
    expect([0, 999, 45_000, 60_000, 200_000, 3_600_000, 7_500_000].map(formatDuration)).toEqual([
      '0s',
      '1s',
      '45s',
      '1m',
      '3m 20s',
      '1h',
      '2h 5m',
    ]);
  });

  it('links the run in the checks tab of its app', () => {
    expect(
      checkTargetUrl('https://deploy.example.com', 'app_01' as AppId, 'chk_01' as CheckRunId),
    ).toBe('https://deploy.example.com/apps/app_01?tab=checks&check=chk_01');
  });
});

interface Call {
  route: string;
  params: Record<string, unknown>;
}

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });
}

class FakeOctokit implements OctokitLike {
  readonly calls: Call[] = [];
  handler: (call: Call) => OctokitResponse = () => ({ status: 201, data: {}, headers: {} });

  async request(route: string, params: Record<string, unknown> = {}) {
    const { request: _options, ...rest } = params;
    const call = { route, params: rest };
    this.calls.push(call);
    return this.handler(call);
  }

  /** `[state, description]` of every posted status. */
  posted() {
    return this.calls.map((call) => [call.params.state, call.params.description]);
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

class MemoryStore implements StatusStore {
  readonly snapshots = new Map<CheckRunId, StatusSnapshot>();
  publicUrl: string | null = 'https://deploy.example.com';

  add(status: CheckRunStatus, conn: ConnectionRow = connection()): CheckRunId {
    const id = generateId('chk');
    this.snapshots.set(id, {
      run: runOf({ id, status }),
      app: { repoOwner: 'octo', repoName: 'trail' },
      connection: conn,
      publicUrl: this.publicUrl,
    });
    return id;
  }

  patch(id: CheckRunId, fields: Partial<StatusRun>) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error('unknown');
    this.snapshots.set(id, { ...snapshot, run: { ...snapshot.run, ...fields } });
  }

  async load(id: CheckRunId) {
    return this.snapshots.get(id) ?? null;
  }

  async saveGitHubState(id: CheckRunId, state: GitHubCommitStatusState) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.run.githubState === state) return false;
    this.patch(id, { githubState: state });
    return true;
  }

  async unsynced() {
    return [...this.snapshots.values()]
      .filter((s) => s.run.githubState !== commitStatusOf(s.run).state)
      .map((s) => s.run.id);
  }
}

describe('checks mirror', () => {
  let deps: Deps;
  let store: MemoryStore;
  let octokit: FakeOctokit;
  let clock: number;
  let events: PlatformEvent[];
  let mirror: ReturnType<typeof createChecksMirror>;

  beforeEach(() => {
    deps = createTestDeps();
    store = new MemoryStore();
    octokit = new FakeOctokit();
    clock = Date.parse('2026-10-27T12:00:00Z');
    events = [];
    deps.events.subscribe((event) => events.push(event));
    mirror = createChecksMirror(deps, {
      store,
      octokitFor: async () => octokit,
      sleep: async () => {},
      now: () => clock,
    });
  });

  it('posts the status launchway/<name> with a link to the run, once per change', async () => {
    const id = store.add('queued');
    expect(await mirror.sync(id)).toBe('posted');
    expect(octokit.calls).toEqual([
      {
        route: 'POST /repos/{owner}/{repo}/statuses/{sha}',
        params: {
          owner: 'octo',
          repo: 'trail',
          sha: 'a'.repeat(40),
          state: 'pending',
          description: 'Queued',
          context: 'launchway/quality',
          target_url: `https://deploy.example.com/apps/app_01?tab=checks&check=${id}`,
        },
      },
    ]);
    expect(await mirror.sync(id)).toBe('unchanged');

    store.patch(id, { status: 'running', startedAt: STARTED });
    expect(await mirror.sync(id)).toBe('posted');
    store.patch(id, { status: 'succeeded', reason: 'exit', exitCode: 0, ...finished(42) });
    expect(await mirror.sync(id)).toBe('posted');
    expect(octokit.posted()).toEqual([
      ['pending', 'Queued'],
      ['pending', 'Running'],
      ['success', 'Passed in 42s'],
    ]);
  });

  it('records the posted state and announces it without a status', async () => {
    const id = store.add('running');
    await mirror.sync(id);
    expect(store.snapshots.get(id)?.run.githubState).toBe('pending');
    expect(events).toEqual([
      expect.objectContaining({
        topic: 'checks',
        action: 'updated',
        resourceId: id,
        data: { appId: 'app_01', githubState: 'pending' },
      }),
    ]);
    // The same state with another description: posted, but nothing new to record.
    store.patch(id, { status: 'queued' });
    await mirror.sync(id);
    expect(events).toHaveLength(1);
  });

  it('leaves out the link without a public URL', async () => {
    store.publicUrl = null;
    const id = store.add('queued');
    await mirror.sync(id);
    expect(octokit.calls[0]?.params).not.toHaveProperty('target_url');
  });

  it('pauses statuses of a connection GitHub refused, apart from deployments', async () => {
    const conn = connection();
    const first = store.add('queued', conn);
    const second = store.add('queued', conn);
    octokit.handler = () => {
      throw httpError(403);
    };
    expect(await mirror.sync(first)).toBe('denied');
    const shared = githubConnectionState(deps.events);
    expect(shared.statusDenials.get(conn.id)).toEqual({ at: clock, status: 403 });
    expect(shared.denials.has(conn.id)).toBe(false);
    expect(events.filter((e) => e.topic === 'github')).toEqual([
      expect.objectContaining({ resourceId: conn.id, data: { capabilities: true } }),
    ]);

    // Paused: nothing is sent for 5 minutes, and the refusal is announced once.
    expect(await mirror.sync(second)).toBe('denied');
    expect(octokit.calls).toHaveLength(1);
    clock += DENIAL_PAUSE_MS;
    expect(await mirror.sync(second)).toBe('denied');
    expect(octokit.calls).toHaveLength(2);
    expect(events.filter((e) => e.topic === 'github')).toHaveLength(1);

    // Granted: the next attempt goes through and clears the refusal.
    clock += DENIAL_PAUSE_MS;
    octokit.handler = () => ({ status: 201, data: {}, headers: {} });
    expect(await mirror.sync(second)).toBe('posted');
    expect(shared.statusDenials.has(conn.id)).toBe(false);
  });

  it('retries rate limits and never fails on other errors', async () => {
    const id = store.add('queued');
    let attempts = 0;
    octokit.handler = () => {
      attempts += 1;
      if (attempts === 1) throw httpError(403, { 'x-ratelimit-remaining': '0' });
      if (attempts === 2) throw httpError(429, { 'retry-after': '1' });
      return { status: 201, data: {}, headers: {} };
    };
    expect(await mirror.sync(id)).toBe('posted');
    expect(attempts).toBe(3);

    store.patch(id, { status: 'running' });
    octokit.handler = () => {
      throw httpError(500);
    };
    expect(await mirror.sync(id)).toBe('failed');
    expect(await mirror.sync(generateId('chk'))).toBe('skipped');
  });

  it('follows status events only and coalesces them per run', async () => {
    const id = store.add('queued');
    const event = (data: Record<string, unknown>) =>
      ({
        id: '1',
        topic: 'checks',
        action: 'updated',
        resourceId: id,
        at: new Date().toISOString(),
        data,
      }) as PlatformEvent;
    mirror.onEvent(event({ appId: 'app_01', githubState: 'pending' }));
    await mirror.idle();
    expect(octokit.calls).toHaveLength(0);
    mirror.onEvent(event({ appId: 'app_01', status: 'queued' }));
    mirror.onEvent(event({ appId: 'app_01', status: 'queued' }));
    mirror.onEvent(event({ appId: 'app_01', status: 'queued' }));
    await mirror.idle();
    expect(octokit.posted()).toEqual([['pending', 'Queued']]);
  });

  it('re-syncs runs whose posted state is not their current one', async () => {
    const pending = store.add('running');
    const done = store.add('failed');
    store.patch(done, { reason: 'exit', exitCode: 1, ...finished(5), githubState: 'pending' });
    const synced = store.add('succeeded');
    store.patch(synced, { reason: 'exit', exitCode: 0, ...finished(5), githubState: 'success' });
    await mirror.resync();
    expect(octokit.calls.map((call) => call.params.state)).toEqual(['pending', 'failure']);
    expect(store.snapshots.get(pending)?.run.githubState).toBe('pending');
    expect(store.snapshots.get(done)?.run.githubState).toBe('failure');
  });
});
