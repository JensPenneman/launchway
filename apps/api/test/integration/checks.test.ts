import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  type App,
  type CheckItemInput,
  type CheckRun,
  type CheckRunId,
  type CheckRunList,
  type CheckRunPage,
  type CreatedNode,
  type GitHubConnectionCapabilities,
  generateId,
  githubStateOfCheck,
  type LogLine,
  type NodeId,
  type PlatformEvent,
  type Settings,
  type UpdateAppChecksSettings,
} from '@launchway/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import {
  auditEvents,
  checkLogLines,
  checkRuns,
  deployments,
  githubConnections,
  nodes,
  settings,
  users,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import {
  AgentUnavailableError,
  createDeferredCheckSink,
  noopDeploymentSink,
} from '../../src/lib/agent-gateway.js';
import {
  createCheckDispatcher,
  NODE_TIMEOUT_MESSAGE,
} from '../../src/modules/checks/dispatcher.js';
import { createChecksMirror } from '../../src/modules/checks/mirror.js';
import { NODE_OFFLINE_MESSAGE, UNSUPPORTED_AGENT_MESSAGE } from '../../src/modules/checks/model.js';
import {
  APP_DELETED_MESSAGE,
  APP_MOVED_MESSAGE,
  CANCEL_REQUESTED_MESSAGE,
  createChecksService,
} from '../../src/modules/checks/service.js';
import {
  createCheckSink,
  LOST_RUN_MESSAGE,
  MAX_STORED_LINES,
} from '../../src/modules/checks/sink.js';
import { secretContext } from '../../src/modules/github/providers.js';
import { resetConnectionState } from '../../src/modules/github/state.js';
import { createAgentGateway, type NodeAgentGateway } from '../../src/modules/nodes/gateway.js';
import { startTestServer, TestAgent } from '../support/agent-client.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { FakeAgentGateway } from '../support/fake-agent-gateway.js';
import { FakeGitHub, testPrivateKey } from '../support/fake-github.js';
import { parseSse } from '../support/sse.js';

const PUBLIC_URL = 'https://deploy.example.com';
const quality: CheckItemInput = { name: 'quality', command: '  npm ci && npm run check  ' };
const e2e: CheckItemInput = {
  name: 'e2e',
  command: 'npm run e2e',
  service: 'e2e',
  composeFile: 'compose.e2e.yaml',
  timeoutMinutes: 10,
};
const lint: CheckItemInput = { name: 'lint', command: 'npm run lint' };

/** `UpdateAppChecksSettings` as sent: items may leave out the service and the timeout. */
type ChecksPatch = Omit<UpdateAppChecksSettings, 'items'> & { items?: CheckItemInput[] };
const human = { login: 'octocat', type: 'User' };
const dependabot = { login: 'dependabot[bot]', type: 'Bot' };

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A full commit SHA for a label (unlike `sha()` of the fixtures, the whole label counts). */
const sha = (label: string) => createHash('sha1').update(label).digest('hex');

let counter = 0;
const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const line = (seq: number, text: string, stream: LogLine['stream'] = 'stdout'): LogLine => ({
  seq,
  timestamp: new Date().toISOString(),
  stream,
  line: text,
});

describe('checks against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  const github = new FakeGitHub();
  const gateway = new FakeAgentGateway();
  const admin = testPrincipal('admin');
  const ghAppId = randomInt(100_000, 999_999_999);
  const installationId = randomInt(100_000, 999_999_999);
  const webhookSecret = randomBytes(16).toString('hex');
  const connectionId = generateId('gh');
  let originalSettings: Partial<typeof settings.$inferInsert> | undefined;

  function webhook(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': randomUUID(),
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': String(ghAppId),
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
      },
      body,
    };
  }

  async function deliver(event: string, payload: unknown): Promise<void> {
    const res = await api.request('/api/v1/webhooks/github', webhook(event, payload));
    expect(res.status).toBe(204);
  }

  async function newNode(online: boolean): Promise<NodeId> {
    const [node] = await db
      .insert(nodes)
      .values({ name: unique('chk-node') })
      .returning({ id: nodes.id });
    if (!node) throw new Error('node insert failed');
    if (online) gateway.connect(node.id);
    return node.id;
  }

  /** An app of a new (or the given) repository on `nodeId`, with these check settings. */
  async function createTestApp(
    nodeId: NodeId,
    checks?: ChecksPatch,
    options: {
      repo?: string;
      branches?: Record<string, string>;
      extra?: Record<string, unknown>;
      using?: ReturnType<typeof createApp>;
    } = {},
  ): Promise<{ app: App; repo: string; mainSha: string }> {
    const repo = options.repo ?? unique('checked');
    const mainSha = sha(`${repo}-main`);
    if (!options.repo) {
      github.addRepo({
        owner: 'octo',
        name: repo,
        branches: { main: mainSha, ...options.branches },
      });
    }
    const client = options.using ?? api;
    const res = await client.request(
      '/api/v1/apps',
      json('POST', {
        name: unique('App'),
        connectionId,
        repository: { owner: 'octo', name: repo },
        nodeId,
        ...options.extra,
      }),
    );
    expect(res.status).toBe(201);
    let app = (await res.json()) as App;
    if (checks) {
      const patched = await client.request(`/api/v1/apps/${app.id}`, json('PATCH', { checks }));
      expect(patched.status).toBe(200);
      app = (await patched.json()) as App;
    }
    return { app, repo, mainSha };
  }

  const repository = (repo: string) => ({ name: repo, owner: { login: 'octo' } });

  const push = (repo: string, branch: string, after: string, sender = human) => ({
    ref: `refs/heads/${branch}`,
    after,
    deleted: false,
    sender,
    repository: repository(repo),
  });

  function pullRequest(
    repo: string,
    action: string,
    number: number,
    head: string,
    options: { base?: string; headRef?: string; fork?: boolean; author?: typeof human } = {},
  ) {
    const fullName = `octo/${repo}`;
    return {
      action,
      number,
      pull_request: {
        title: `Change ${number}`,
        state: action === 'closed' ? 'closed' : 'open',
        user: options.author ?? human,
        labels: [],
        head: {
          ref: options.headRef ?? `feature/${number}`,
          sha: head,
          repo: { full_name: options.fork ? `forker/${repo}` : fullName },
        },
        base: { ref: options.base ?? 'main', repo: { full_name: fullName } },
      },
      repository: repository(repo),
    };
  }

  async function runsOf(appId: string) {
    return db
      .select()
      .from(checkRuns)
      .where(eq(checkRuns.appId, appId as App['id']))
      .orderBy(asc(checkRuns.createdAt), asc(checkRuns.name));
  }

  async function runRow(id: string) {
    const [row] = await db
      .select()
      .from(checkRuns)
      .where(eq(checkRuns.id, id as CheckRunId));
    if (!row) throw new Error(`no check run ${id}`);
    return row;
  }

  async function auditsOf(id: string) {
    return db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, id))
      .orderBy(asc(auditEvents.createdAt));
  }

  async function createRuns(appId: string, body: unknown, using = api): Promise<CheckRun[]> {
    const res = await using.request(`/api/v1/apps/${appId}/checks`, json('POST', body));
    expect(res.status).toBe(201);
    return ((await res.json()) as CheckRunList).items;
  }

  /** A run inserted as `running` on `nodeId` (the agent's side is played by the test). */
  async function runningRun(appId: App['id'], nodeId: NodeId, startedAt = new Date()) {
    const [row] = await db
      .insert(checkRuns)
      .values({
        appId,
        nodeId,
        name: 'quality',
        command: 'npm test',
        service: 'dev',
        composeFiles: ['.devcontainer/compose.yaml'],
        timeoutMinutes: 30,
        commitSha: sha(unique('running')),
        ref: 'main',
        trigger: 'manual',
        status: 'running',
        startedAt,
      })
      .returning();
    if (!row) throw new Error('run insert failed');
    return row;
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    const base = createTestDeps({ db, auth: fixedAuth(admin), agents: gateway });
    deps = { ...base, config: { ...base.config, publicUrl: PUBLIC_URL } };
    api = createApp(deps);
    await db.insert(users).values({
      id: admin.user.id,
      email: `${unique('admin')}@example.com`,
      name: 'Admin',
      role: 'admin',
    });
    // The settings row is a singleton shared with other test files: put it back afterwards.
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    const [current] = await db.select().from(settings).where(eq(settings.id, 1));
    originalSettings = {
      checkMemoryMb: current?.checkMemoryMb ?? 4096,
      checkCpus: current?.checkCpus ?? 2,
      checkPidsLimit: current?.checkPidsLimit ?? 4096,
      checkMaxQueuedPerApp: current?.checkMaxQueuedPerApp ?? 30,
      checkMaxQueuedPerNode: current?.checkMaxQueuedPerNode ?? 100,
    };
    github.apps.set(ghAppId, {
      id: ghAppId,
      slug: `launchway-checks-${ghAppId}`,
      webhookSecret,
      privateKey: testPrivateKey(),
      installations: new Map([[installationId, { login: 'octo', type: 'User' }]]),
    });
    await db.insert(githubConnections).values({
      id: connectionId,
      kind: 'app',
      name: unique('GitHub App'),
      accountLogin: 'octo',
      accountType: 'User',
      appId: ghAppId,
      appSlug: `launchway-checks-${ghAppId}`,
      privateKeyEncrypted: deps.secrets.encrypt(
        testPrivateKey(),
        secretContext.privateKey(connectionId),
      ),
      webhookSecretEncrypted: deps.secrets.encrypt(
        webhookSecret,
        secretContext.webhookSecret(connectionId),
      ),
      installationId,
    });
  });

  afterAll(async () => {
    if (originalSettings) await db.update(settings).set(originalSettings);
    deps.lifecycle.beginShutdown();
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('stores check settings: partial updates, normalised items, audited', async () => {
    const node = await newNode(false);
    const { app } = await createTestApp(node);
    expect(app.checks).toEqual({
      enabled: false,
      composeFiles: ['.devcontainer/compose.yaml'],
      branches: null,
      skipBots: false,
      items: [],
    });
    const patch = async (checks: unknown) => {
      const res = await api.request(`/api/v1/apps/${app.id}`, json('PATCH', { checks }));
      return { status: res.status, body: (await res.json()) as App };
    };
    const first = await patch({ enabled: true, items: [quality, e2e] });
    expect(first.status).toBe(200);
    expect(first.body.checks).toEqual({
      enabled: true,
      composeFiles: ['.devcontainer/compose.yaml'],
      branches: null,
      skipBots: false,
      items: [
        {
          name: 'quality',
          command: 'npm ci && npm run check',
          service: 'dev',
          timeoutMinutes: 30,
        },
        {
          name: 'e2e',
          command: 'npm run e2e',
          service: 'e2e',
          composeFile: 'compose.e2e.yaml',
          timeoutMinutes: 10,
        },
      ],
    });
    // Omitted fields keep their value; items replace the list.
    const second = await patch({ branches: ['main'], items: [lint] });
    expect(second.body.checks).toMatchObject({
      enabled: true,
      branches: ['main'],
      items: [{ name: 'lint', service: 'dev', timeoutMinutes: 30 }],
    });
    expect((await patch({ items: [lint, lint] })).status).toBe(400);
    const [audit] = (await auditsOf(app.id)).filter((a) => a.action === 'app.update');
    expect(audit?.summary).toMatchObject({
      checks: { from: expect.objectContaining({ enabled: false }), to: { enabled: true } },
    });
  });

  it('queues the checks of pushes and same-repository pull requests as the filters allow', async () => {
    const node = await newNode(false);
    const { app, repo } = await createTestApp(
      node,
      { enabled: true, branches: ['main'], skipBots: true, items: [quality, e2e] },
      { extra: { autoDeployBranch: 'main' } },
    );
    // Another app of the repository with checks off.
    const { app: quiet } = await createTestApp(node, { items: [quality] }, { repo });
    const pushed = sha(`${repo}-push-1`);

    // One delivery deploys (autoDeployBranch) and runs the checks.
    await deliver('push', push(repo, 'main', pushed));
    const runs = await runsOf(app.id);
    expect(runs.map((r) => r.name).sort()).toEqual(['e2e', 'quality']);
    for (const run of runs) {
      expect(run).toMatchObject({
        nodeId: node,
        commitSha: pushed,
        ref: 'main',
        prNumber: null,
        trigger: 'push',
        status: 'queued',
        triggeredById: null,
      });
    }
    expect(runs.find((r) => r.name === 'quality')).toMatchObject({
      command: 'npm ci && npm run check',
      service: 'dev',
      composeFiles: ['.devcontainer/compose.yaml'],
      timeoutMinutes: 30,
    });
    expect(runs.find((r) => r.name === 'e2e')).toMatchObject({
      service: 'e2e',
      composeFiles: ['compose.e2e.yaml'],
      timeoutMinutes: 10,
    });
    const deployed = await db.select().from(deployments).where(eq(deployments.appId, app.id));
    expect(deployed).toEqual([
      expect.objectContaining({ ref: 'main', commitSha: pushed, trigger: 'auto' }),
    ]);
    expect(await runsOf(quiet.id)).toEqual([]);
    const [created] = await auditsOf(runs[0]?.id ?? '');
    expect(created).toMatchObject({
      action: 'check.create',
      actorType: 'system',
      actorLabel: 'github-webhook',
      summary: expect.objectContaining({ appId: app.id, commitSha: pushed, trigger: 'push' }),
    });

    // Redeliveries, filtered branches, bots, tags and deletions add nothing.
    await deliver('push', push(repo, 'main', pushed));
    await deliver('push', push(repo, 'feature/x', sha(`${repo}-feature`)));
    await deliver('push', push(repo, 'main', sha(`${repo}-bot`), dependabot));
    await deliver('push', { ...push(repo, 'main', sha(`${repo}-tag`)), ref: 'refs/tags/v1.0.0' });
    await deliver('push', { ...push(repo, 'old', '0'.repeat(40)), deleted: true });
    expect(await runsOf(app.id)).toHaveLength(2);

    // A pull request from a branch of the repository into main runs them for its head.
    const head = sha(`${repo}-pr-12`);
    await deliver('pull_request', pullRequest(repo, 'opened', 12, head));
    const prRuns = (await runsOf(app.id)).filter((r) => r.commitSha === head);
    expect(prRuns.map((r) => [r.name, r.trigger, r.ref, r.prNumber]).sort()).toEqual([
      ['e2e', 'pull_request', 'feature/12', 12],
      ['quality', 'pull_request', 'feature/12', 12],
    ]);

    // Forks, bots, other base branches, other actions and invalid head refs run nothing.
    await deliver('pull_request', pullRequest(repo, 'opened', 13, sha('f'), { fork: true }));
    await deliver(
      'pull_request',
      pullRequest(repo, 'opened', 14, sha(`${repo}-14`), { author: dependabot }),
    );
    await deliver(
      'pull_request',
      pullRequest(repo, 'synchronize', 15, sha(`${repo}-15`), { base: 'develop' }),
    );
    await deliver('pull_request', pullRequest(repo, 'edited', 16, sha(`${repo}-16`)));
    await deliver('pull_request', pullRequest(repo, 'closed', 17, sha(`${repo}-17`)));
    await deliver(
      'pull_request',
      pullRequest(repo, 'reopened', 18, sha(`${repo}-18`), { headRef: '-bad' }),
    );
    expect(await runsOf(app.id)).toHaveLength(4);
  });

  it('supersedes queued runs of an older commit of the branch, never running or manual ones', async () => {
    const node = await newNode(false);
    const { app, repo } = await createTestApp(
      node,
      { enabled: true, items: [quality] },
      { branches: { 'feature/a': sha('sup-head') } },
    );
    const [manual] = await createRuns(app.id, { ref: 'feature/a' });
    expect(manual).toMatchObject({ commitSha: sha('sup-head'), trigger: 'manual' });

    await deliver('push', push(repo, 'feature/a', sha(`${repo}-1`)));
    const [first] = (await runsOf(app.id)).filter((r) => r.commitSha === sha(`${repo}-1`));
    await deliver('push', push(repo, 'feature/a', sha(`${repo}-2`)));
    const superseded = await runRow(first?.id ?? '');
    expect(superseded).toMatchObject({
      status: 'cancelled',
      reason: 'superseded',
      statusMessage: `Superseded by ${sha(`${repo}-2`).slice(0, 12)}`,
    });
    expect(superseded.finishedAt).not.toBeNull();
    expect((await runRow(manual?.id ?? '')).status).toBe('queued');
    const cancelled = (await auditsOf(first?.id ?? '')).find((a) => a.action === 'check.cancel');
    expect(cancelled?.summary).toMatchObject({ supersededBy: sha(`${repo}-2`) });

    // A run sent to its node is left alone; pull requests of the branch supersede too.
    const [second] = (await runsOf(app.id)).filter((r) => r.commitSha === sha(`${repo}-2`));
    await db
      .update(checkRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(checkRuns.id, second?.id as CheckRunId));
    await deliver(
      'pull_request',
      pullRequest(repo, 'synchronize', 3, sha(`${repo}-3`), { headRef: 'feature/a' }),
    );
    expect((await runRow(second?.id ?? '')).status).toBe('running');
    const [third] = (await runsOf(app.id)).filter((r) => r.commitSha === sha(`${repo}-3`));
    expect(third).toMatchObject({ trigger: 'pull_request', prNumber: 3, status: 'queued' });
    await deliver('push', push(repo, 'feature/a', sha(`${repo}-4`)));
    expect((await runRow(third?.id ?? '')).reason).toBe('superseded');

    // The newest push of the branch runs, whatever the commit: a commit whose runs were
    // superseded runs again when it is pushed again (a force-push back), and supersedes in turn.
    const [fourth] = (await runsOf(app.id)).filter((r) => r.commitSha === sha(`${repo}-4`));
    await deliver('push', push(repo, 'feature/a', sha(`${repo}-3`)));
    const again = (await runsOf(app.id)).filter((r) => r.commitSha === sha(`${repo}-3`));
    expect(again.map((r) => [r.status, r.reason])).toEqual([
      ['cancelled', 'superseded'],
      ['queued', null],
    ]);
    expect((await runRow(fourth?.id ?? '')).reason).toBe('superseded');
    // The same commit again while it is queued adds nothing and supersedes nothing.
    await deliver('push', push(repo, 'feature/a', sha(`${repo}-3`)));
    await deliver(
      'pull_request',
      pullRequest(repo, 'synchronize', 3, sha(`${repo}-3`), { headRef: 'feature/a' }),
    );
    expect((await runsOf(app.id)).filter((r) => r.commitSha === sha(`${repo}-3`))).toHaveLength(2);
    await db
      .update(checkRuns)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(checkRuns.id, second?.id as CheckRunId));
  });

  it('bounds the queue per app and per node: runs beyond end at once as queue-full', async () => {
    const setLimits = async (perApp: number, perNode: number) => {
      const res = await api.request(
        '/api/v1/settings',
        json('PATCH', { checkMaxQueuedPerApp: perApp, checkMaxQueuedPerNode: perNode }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        checkMaxQueuedPerApp: perApp,
        checkMaxQueuedPerNode: perNode,
      } satisfies Partial<Settings>);
    };
    await setLimits(2, 3);
    try {
      // An offline node: every run stays queued.
      const node = await newNode(false);
      const { app, repo } = await createTestApp(node, { enabled: true, items: [quality, lint] });
      await deliver('push', push(repo, 'feature/one', sha(`${repo}-one`)));
      await deliver('push', push(repo, 'feature/two', sha(`${repo}-two`)));
      const runs = await runsOf(app.id);
      const one = runs.filter((r) => r.commitSha === sha(`${repo}-one`));
      const two = runs.filter((r) => r.commitSha === sha(`${repo}-two`));
      expect(one.map((r) => r.status)).toEqual(['queued', 'queued']);
      // Both checks of the second push: all or nothing, ended at once so GitHub shows why.
      for (const run of two) {
        expect(run).toMatchObject({
          status: 'errored',
          reason: 'queue-full',
          statusMessage:
            'Not run: the app already has 2 queued checks (at most 2); run it again later',
        });
        expect(run.finishedAt).not.toBeNull();
        expect((await auditsOf(run.id)).map((a) => [a.action, a.summary])).toEqual([
          ['check.create', expect.objectContaining({ status: 'errored', reason: 'queue-full' })],
        ]);
      }
      expect(gateway.checkRuns.filter((r) => two.some((t) => t.id === r.payload.runId))).toEqual(
        [],
      );

      // By hand the request is refused instead.
      const manual = await api.request(
        `/api/v1/apps/${app.id}/checks`,
        json('POST', { ref: 'main' }),
      );
      expect(manual.status).toBe(409);
      expect(((await manual.json()) as { detail: string }).detail).toBe(
        'Not queued: the app already has 2 queued checks (at most 2); wait for them or raise the limit',
      );

      // The node's bound counts the queued runs of all its apps.
      const other = await createTestApp(node, { enabled: true, items: [quality, lint] });
      await deliver('push', push(other.repo, 'main', sha(`${other.repo}-x`)));
      const others = await runsOf(other.app.id);
      expect(others.map((r) => [r.status, r.reason, r.statusMessage])).toEqual([
        [
          'errored',
          'queue-full',
          'Not run: its node already has 2 queued checks (at most 3); run it again later',
        ],
        [
          'errored',
          'queue-full',
          'Not run: its node already has 2 queued checks (at most 3); run it again later',
        ],
      ]);

      // Once there is room, pushing the commit again queues it: runs that never ran do not count.
      await setLimits(4, 10);
      await deliver('push', push(repo, 'feature/two', sha(`${repo}-two`)));
      const queuedTwo = (await runsOf(app.id)).filter(
        (r) => r.commitSha === sha(`${repo}-two`) && r.status === 'queued',
      );
      expect(queuedTwo).toHaveLength(2);
    } finally {
      await setLimits(30, 100);
    }
  });

  it('runs checks by hand, re-runs finished runs and cancels queued ones', async () => {
    const node = await newNode(false);
    const { app, mainSha } = await createTestApp(node, { items: [quality, lint] });
    // Runs started through the API do not need checks.enabled.
    expect(app.checks.enabled).toBe(false);
    const created = await createRuns(app.id, { ref: 'main' });
    expect(created.map((r) => r.name).sort()).toEqual(['lint', 'quality']);
    for (const run of created) {
      expect(run).toMatchObject({
        appId: app.id,
        nodeId: node,
        commitSha: mainSha,
        ref: 'main',
        prNumber: null,
        trigger: 'manual',
        status: 'queued',
        triggeredBy: admin.user.id,
        githubState: null,
      });
    }
    const problem = async (body: unknown, appId: string = app.id) => {
      const res = await api.request(`/api/v1/apps/${appId}/checks`, json('POST', body));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await problem({ ref: 'main' })).toMatchObject({
      status: 409,
      body: { detail: `Every requested check already runs for ${mainSha.slice(0, 7)}` },
    });
    expect(await problem({ ref: 'main', names: ['nope', 'other'] })).toMatchObject({
      status: 400,
      body: { errors: [{ path: 'body.names', message: 'Unknown checks "nope", "other"' }] },
    });
    expect(await problem({ ref: 'missing' })).toMatchObject({
      status: 400,
      body: { errors: [{ path: 'body.ref' }] },
    });
    github.failRepoRequests = 1;
    expect((await problem({ ref: 'main' })).status).toBe(502);
    const { app: unconfigured } = await createTestApp(node);
    expect((await problem({ ref: 'main' }, unconfigured.id)).status).toBe(409);
    expect((await problem({ ref: 'main' }, generateId('app'))).status).toBe(404);

    const lintRun = created.find((r) => r.name === 'lint') as CheckRun;
    const qualityRun = created.find((r) => r.name === 'quality') as CheckRun;
    const cancel = await api.request(`/api/v1/checks/${lintRun.id}/cancel`, json('POST'));
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
      statusMessage: 'Cancelled',
    });
    expect((await api.request(`/api/v1/checks/${lintRun.id}/cancel`, json('POST'))).status).toBe(
      409,
    );
    expect((await api.request(`/api/v1/checks/${qualityRun.id}/rerun`, json('POST'))).status).toBe(
      409,
    );

    // A re-run takes the check's current configuration.
    await api.request(
      `/api/v1/apps/${app.id}`,
      json('PATCH', {
        checks: { items: [quality, { ...lint, command: 'npm run lint -- --fix' }] },
      }),
    );
    const rerun = await api.request(`/api/v1/checks/${lintRun.id}/rerun`, json('POST'));
    expect(rerun.status).toBe(201);
    const again = (await rerun.json()) as CheckRun;
    expect(again).toMatchObject({
      name: 'lint',
      command: 'npm run lint -- --fix',
      commitSha: mainSha,
      ref: 'main',
      trigger: 'manual',
      status: 'queued',
      triggeredBy: admin.user.id,
    });
    expect((await auditsOf(again.id))[0]).toMatchObject({
      action: 'check.create',
      actorId: admin.user.id,
      summary: expect.objectContaining({ rerunOf: lintRun.id }),
    });
    const conflict = await api.request(`/api/v1/checks/${lintRun.id}/rerun`, json('POST'));
    expect(conflict.status).toBe(409);
    await api.request(`/api/v1/checks/${again.id}/cancel`, json('POST'));
    await api.request(`/api/v1/apps/${app.id}`, json('PATCH', { checks: { items: [quality] } }));
    const gone = await api.request(`/api/v1/checks/${lintRun.id}/rerun`, json('POST'));
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ detail: 'The check "lint" is no longer configured' });

    // Lists: newest first, filters, cursors.
    const list = async (query: string) =>
      (await (await api.request(`/api/v1/apps/${app.id}/checks${query}`)).json()) as CheckRunPage;
    expect((await list('')).items.map((r) => r.id)).toEqual([
      again.id,
      ...created
        .map((r) => r.id)
        .sort()
        .reverse(),
    ]);
    expect((await list('?status=cancelled')).items.map((r) => r.id).sort()).toEqual(
      [lintRun.id, again.id].sort(),
    );
    expect((await list('?name=quality')).items.map((r) => r.id)).toEqual([qualityRun.id]);
    expect((await list(`?commitSha=${sha('other')}`)).items).toEqual([]);
    const pageOne = await list('?limit=2');
    expect(pageOne.items).toHaveLength(2);
    const pageTwo = await list(`?limit=2&cursor=${pageOne.nextCursor}`);
    expect(pageTwo).toMatchObject({ items: [expect.any(Object)], nextCursor: null });
    expect(new Set([...pageOne.items, ...pageTwo.items].map((r) => r.id)).size).toBe(3);
    expect((await api.request(`/api/v1/checks/${qualityRun.id}`)).status).toBe(200);
    expect((await api.request(`/api/v1/checks/${generateId('chk')}`)).status).toBe(404);
    expect((await api.request(`/api/v1/apps/${generateId('app')}/checks`)).status).toBe(404);

    const viewer = createApp({ ...deps, auth: fixedAuth(testPrincipal('viewer')) });
    expect((await viewer.request(`/api/v1/checks/${qualityRun.id}`)).status).toBe(200);
    expect(
      (await viewer.request(`/api/v1/checks/${qualityRun.id}/cancel`, json('POST'))).status,
    ).toBe(403);
    const actions = (await auditsOf(lintRun.id)).map((a) => [a.action, a.actorType]);
    expect(actions).toEqual([
      ['check.create', 'user'],
      ['check.cancel', 'user'],
    ]);
  });

  it('sends one run per node at a time across apps, with the platform limits', async () => {
    const limits = await api.request(
      '/api/v1/settings',
      json('PATCH', { checkMemoryMb: 1024, checkCpus: 1.5, checkPidsLimit: 512 }),
    );
    expect(limits.status).toBe(200);
    expect(await limits.json()).toMatchObject({
      checkMemoryMb: 1024,
      checkCpus: 1.5,
      checkPidsLimit: 512,
    } satisfies Partial<Settings>);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'settings.update'), eq(auditEvents.actorId, admin.user.id)))
      .orderBy(asc(auditEvents.createdAt));
    const audit = audits.find((entry) => entry.summary && 'checkMemoryMb' in entry.summary);
    expect(audit?.summary).toMatchObject({ checkMemoryMb: { to: 1024 }, checkCpus: { to: 1.5 } });

    const node = await newNode(true);
    const sink = createCheckSink(deps);
    const { app: first, repo, mainSha } = await createTestApp(node, { items: [quality] });
    const { app: second } = await createTestApp(node, { items: [quality] });
    const [a] = await createRuns(first.id, { ref: 'main' });
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === a?.id));
    const [b] = await createRuns(second.id, { ref: 'main' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await runRow(b?.id ?? '')).status).toBe('queued');
    expect(await runRow(a?.id ?? '')).toMatchObject({
      status: 'running',
      startedAt: expect.any(Date),
    });
    const sent = gateway.checkRuns.find((r) => r.payload.runId === a?.id);
    expect(sent).toEqual({
      nodeId: node,
      payload: {
        runId: a?.id,
        app: { id: first.id, slug: first.slug },
        source: {
          cloneUrl: `https://github.com/octo/${repo}.git`,
          ref: 'main',
          sha: mainSha,
          authorization: expect.stringMatching(/^basic [A-Za-z0-9+/=]+$/),
        },
        composeFiles: ['.devcontainer/compose.yaml'],
        check: {
          name: 'quality',
          service: 'dev',
          command: 'npm ci && npm run check',
          timeoutMs: 30 * 60_000,
        },
        limits: { memoryBytes: 1024 * 1024 * 1024, cpus: 1.5, pidsLimit: 512 },
      },
    });
    // A fresh token for this repository only, limited to contents: read.
    expect(github.tokenRequests).toContainEqual({
      repositories: [repo],
      permissions: { contents: 'read' },
    });

    // Lines get gap-free sequence numbers of their own, whatever the agent sends.
    await sink.onLog(node, { runId: a?.id as CheckRunId, lines: [line(7, 'a'), line(8, 'b')] });
    await sink.onLog(node, { runId: a?.id as CheckRunId, lines: [line(3, 'c', 'stderr')] });
    await sink.onResult(node, { runId: a?.id as CheckRunId, reason: 'exit', exitCode: 0 });
    expect(await runRow(a?.id ?? '')).toMatchObject({
      status: 'succeeded',
      reason: 'exit',
      exitCode: 0,
      finishedAt: expect.any(Date),
    });
    const [succeeded] = (await auditsOf(a?.id ?? '')).filter((r) => r.action === 'check.succeed');
    expect(succeeded).toMatchObject({ actorType: 'agent', actorId: node });
    // The node is free: the next run goes.
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === b?.id));
    expect((await runRow(b?.id ?? '')).status).toBe('running');

    // Late lines, results of other nodes and results of finished runs change nothing.
    await sink.onLog(node, { runId: a?.id as CheckRunId, lines: [line(0, 'late')] });
    const stored = await db
      .select({ seq: checkLogLines.seq, line: checkLogLines.line, stream: checkLogLines.stream })
      .from(checkLogLines)
      .where(eq(checkLogLines.runId, a?.id as CheckRunId))
      .orderBy(asc(checkLogLines.seq));
    expect(stored).toEqual([
      { seq: 0, line: 'a', stream: 'stdout' },
      { seq: 1, line: 'b', stream: 'stdout' },
      { seq: 2, line: 'c', stream: 'stderr' },
    ]);
    const other = await newNode(true);
    await sink.onResult(other, { runId: b?.id as CheckRunId, reason: 'exit', exitCode: 1 });
    await sink.onResult(node, { runId: a?.id as CheckRunId, reason: 'exit', exitCode: 1 });
    expect((await runRow(b?.id ?? '')).status).toBe('running');
    expect((await runRow(a?.id ?? '')).status).toBe('succeeded');
    await sink.onResult(node, { runId: b?.id as CheckRunId, reason: 'exit', exitCode: 1 });
    expect(await runRow(b?.id ?? '')).toMatchObject({
      status: 'failed',
      exitCode: 1,
      statusMessage: 'Exited with code 1',
    });
  });

  it('claims at most one run per node, also when dispatches race', async () => {
    const node = await newNode(false);
    const { app } = await createTestApp(node, {
      items: [quality, lint, { name: 'unit', command: 'npm run unit' }],
    });
    await createRuns(app.id, { ref: 'main' });
    gateway.connect(node);
    const dispatcher = createCheckDispatcher(deps);
    await Promise.all([1, 2, 3, 4].map(() => dispatcher.dispatchNode(node)));
    const statuses = (await runsOf(app.id)).map((r) => r.status).sort();
    expect(statuses).toEqual(['queued', 'queued', 'running']);
    expect(gateway.checkRuns.filter((r) => r.nodeId === node)).toHaveLength(1);
  });

  it('settles every kind of result', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality] });
    const sink = createCheckSink(deps);
    const cases = [
      [{ reason: 'exit', exitCode: 0 }, 'succeeded', null, 'check.succeed'],
      [{ reason: 'exit', exitCode: 3 }, 'failed', 'Exited with code 3', 'check.fail'],
      [{ reason: 'timeout', exitCode: null }, 'failed', 'Timed out after 30 minutes', 'check.fail'],
      [
        { reason: 'policy', exitCode: null, message: 'Bind mounts are not allowed' },
        'errored',
        'Bind mounts are not allowed',
        'check.error',
      ],
      [
        { reason: 'build', exitCode: null, message: 'Build failed\n--- last log lines ---\nx' },
        'errored',
        'Build failed\n--- last log lines ---\nx',
        'check.error',
      ],
      [{ reason: 'infrastructure', exitCode: null }, 'errored', expect.any(String), 'check.error'],
      [
        { reason: 'interrupted', exitCode: null, message: 'Interrupted: the agent shut down' },
        'errored',
        'Interrupted: the agent shut down',
        'check.error',
      ],
      [{ reason: 'cancelled', exitCode: null }, 'cancelled', 'Cancelled', 'check.cancel'],
    ] as const;
    for (const [result, status, statusMessage, action] of cases) {
      const run = await runningRun(app.id, node);
      await sink.onResult(node, { runId: run.id, ...result });
      expect(await runRow(run.id)).toMatchObject({
        status,
        reason: result.reason,
        exitCode: result.exitCode,
        statusMessage,
      });
      expect((await auditsOf(run.id)).map((a) => a.action)).toEqual([action]);
    }
  });

  it('stores a bounded number of lines per run', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality] });
    const run = await runningRun(app.id, node);
    await db.execute(
      sql`INSERT INTO check_log_lines (run_id, seq, stream, line, logged_at)
          SELECT ${run.id}, g, 'stdout', 'earlier', now()
          FROM generate_series(0, ${MAX_STORED_LINES - 2}) AS g`,
    );
    const sink = createCheckSink(deps);
    await sink.onLog(node, {
      runId: run.id,
      lines: [line(0, 'last'), line(1, 'beyond'), line(2, 'beyond')],
    });
    await sink.onLog(node, { runId: run.id, lines: [line(3, 'beyond')] });
    const [stored] = await db
      .select({ count: sql<number>`count(*)::int`, last: sql<number>`max(${checkLogLines.seq})` })
      .from(checkLogLines)
      .where(eq(checkLogLines.runId, run.id));
    expect(stored).toEqual({ count: MAX_STORED_LINES, last: MAX_STORED_LINES - 1 });
    const [last] = await db
      .select({ line: checkLogLines.line })
      .from(checkLogLines)
      .where(and(eq(checkLogLines.runId, run.id), eq(checkLogLines.seq, MAX_STORED_LINES - 1)));
    expect(last?.line).toBe('last');
    await sink.onResult(node, { runId: run.id, reason: 'exit', exitCode: 0 });
  });

  it('streams the log of a run: history, then live lines until it ends', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality] });
    const sink = createCheckSink(deps);
    const [run] = await createRuns(app.id, { ref: 'main' });
    const runId = run?.id as CheckRunId;
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === runId));
    await sink.onLog(node, { runId, lines: [line(0, 'Received by the node', 'system')] });

    const res = await api.request(`/api/v1/checks/${runId}/logs?follow=true`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (marker: string) => {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    };
    // The stored line arrives once the stream follows the run (it subscribes first).
    await readUntil('Received by the node');
    await sink.onLog(node, { runId, lines: [line(0, 'npm test'), line(1, 'ok')] });
    await sink.onResult(node, { runId, reason: 'exit', exitCode: 0 });
    await readUntil('event: end');
    expect(parseSse(text)).toEqual([
      {
        event: 'log',
        id: '0',
        data: expect.objectContaining({ seq: 0, stream: 'system', line: 'Received by the node' }),
      },
      { event: 'log', id: '1', data: expect.objectContaining({ seq: 1, line: 'npm test' }) },
      { event: 'log', id: '2', data: expect.objectContaining({ seq: 2, line: 'ok' }) },
      { event: 'status', data: { status: 'succeeded' } },
      { event: 'end', data: { status: 'succeeded' } },
    ]);
    const after = parseSse(
      await (await api.request(`/api/v1/checks/${runId}/logs?after=0`)).text(),
    );
    expect(after.map((e) => [e.event, e.id])).toEqual([
      ['log', '1'],
      ['log', '2'],
      ['end', undefined],
    ]);
    expect((await api.request(`/api/v1/checks/${generateId('chk')}/logs`)).status).toBe(404);
  });

  it('reports runs to GitHub as commit statuses launchway/<name>', async () => {
    const mirror = createChecksMirror(deps);
    const stop = mirror.start();
    const events: PlatformEvent[] = [];
    const unsubscribe = deps.events.subscribe((event) => events.push(event));
    const node = await newNode(true);
    const sink = createCheckSink(deps);
    const { app, repo, mainSha } = await createTestApp(node, { items: [quality] });
    const [run] = await createRuns(app.id, { ref: 'main' });
    const runId = run?.id as CheckRunId;
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === runId));
    await mirror.idle();
    await sink.onResult(node, { runId, reason: 'exit', exitCode: 0 });
    await mirror.idle();
    const posted = github.commitStatuses.filter((s) => s.repo === `octo/${repo}`);
    expect(posted.every((s) => s.sha === mainSha)).toBe(true);
    expect(posted.slice(0, -1).map((s) => s.body.state)).toEqual(
      expect.arrayContaining(['pending']),
    );
    expect(posted.at(-1)?.body).toEqual({
      state: 'success',
      description: expect.stringMatching(/^Passed in \d+s$/),
      context: 'launchway/quality',
      target_url: `${PUBLIC_URL}/apps/${app.id}?tab=checks&check=${runId}`,
    });
    expect((await runRow(runId)).githubState).toBe('success');
    expect(events).toContainEqual(
      expect.objectContaining({
        topic: 'checks',
        action: 'updated',
        resourceId: runId,
        data: { appId: app.id, githubState: 'success' },
      }),
    );

    // A refusal pauses the statuses of the connection and shows in its capabilities.
    github.denyStatuses = true;
    const [refused] = await createRuns(app.id, { ref: 'main' });
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === refused?.id));
    await mirror.idle();
    const capabilities = (await (
      await api.request(`/api/v1/github/connections/${connectionId}/capabilities`)
    ).json()) as GitHubConnectionCapabilities;
    expect(capabilities.lastStatusDeniedAt).not.toBeNull();
    expect(capabilities.lastDeniedAt).toBeNull();
    const attempts = github.calls.filter((call) => call.includes('/statuses/')).length;
    await sink.onResult(node, { runId: refused?.id as CheckRunId, reason: 'exit', exitCode: 1 });
    await mirror.idle();
    expect(github.calls.filter((call) => call.includes('/statuses/'))).toHaveLength(attempts);
    expect(github.commitStatuses.filter((s) => s.repo === `octo/${repo}`)).toHaveLength(
      posted.length,
    );
    expect((await runRow(refused?.id ?? '')).status).toBe('failed');
    github.denyStatuses = false;
    resetConnectionState(deps.events, connectionId);
    stop();
    unsubscribe();

    // At start, runs whose state GitHub may not show are posted again.
    const restarted = createChecksMirror(deps);
    await restarted.resync();
    await restarted.idle();
    expect(
      github.commitStatuses.filter((s) => s.repo === `octo/${repo}`).at(-1)?.body,
    ).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^Failed: exit code 1 after \d+s$/),
      context: 'launchway/quality',
    });
    expect((await runRow(refused?.id ?? '')).githubState).toBe(githubStateOfCheck('failed'));
  });

  it('prunes log lines after the retention period and keeps the runs', async () => {
    const node = await newNode(false);
    const { app } = await createTestApp(node, { items: [quality] });
    const run = await runningRun(app.id, node);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await db.insert(checkLogLines).values([
      { runId: run.id, seq: 0, stream: 'stdout', line: 'old', loggedAt: old },
      { runId: run.id, seq: 1, stream: 'stdout', line: 'recent', loggedAt: new Date() },
    ]);
    expect(await createChecksService(deps).pruneLogs()).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ line: checkLogLines.line })
      .from(checkLogLines)
      .where(eq(checkLogLines.runId, run.id));
    expect(left).toEqual([{ line: 'recent' }]);
    expect((await runRow(run.id)).status).toBe('running');
    await db
      .update(checkRuns)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(checkRuns.id, run.id));
  });

  it('cancels the runs of an app that is deleted', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality, lint] });
    const created = await createRuns(app.id, { ref: 'main' });
    await until(async () => (await runsOf(app.id)).some((r) => r.status === 'running'));
    const running = (await runsOf(app.id)).find((r) => r.status === 'running');
    const queued = created.find((r) => r.id !== running?.id);
    const res = await api.request(`/api/v1/apps/${app.id}`, json('DELETE'));
    expect(res.status).toBe(204);
    expect(gateway.checkCancels).toContainEqual({ nodeId: node, runId: running?.id });
    expect(await runsOf(app.id)).toEqual([]);
    for (const id of [running?.id, queued?.id]) {
      const cancel = (await auditsOf(id ?? '')).find((a) => a.action === 'check.cancel');
      expect(cancel).toMatchObject({
        actorId: admin.user.id,
        summary: expect.objectContaining({ reason: APP_DELETED_MESSAGE }),
      });
    }
  });

  it('cancels the queued runs of an app that moves to another node', async () => {
    const from = await newNode(false);
    const to = await newNode(false);
    const { app } = await createTestApp(from, { items: [quality] });
    const [run] = await createRuns(app.id, { ref: 'main' });
    const res = await api.request(`/api/v1/apps/${app.id}`, json('PATCH', { nodeId: to }));
    expect(res.status).toBe(200);
    expect(await runRow(run?.id ?? '')).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
      statusMessage: APP_MOVED_MESSAGE,
    });
    // New runs go to the new node.
    const [next] = await createRuns(app.id, { ref: 'main' });
    expect(next?.nodeId).toBe(to);
  });

  it('errors runs left by nodes that have been offline too long', async () => {
    const node = await newNode(false);
    const { app } = await createTestApp(node, { items: [quality] });
    const [queued] = await createRuns(app.id, { ref: 'main' });
    const dispatcher = createCheckDispatcher(deps);
    await dispatcher.tick();
    expect((await runRow(queued?.id ?? '')).status).toBe('queued');
    const old = new Date(Date.now() - 11 * 60_000);
    await db
      .update(checkRuns)
      .set({ createdAt: old })
      .where(eq(checkRuns.id, queued?.id as CheckRunId));
    await db.update(nodes).set({ lastSeenAt: old }).where(eq(nodes.id, node));
    await dispatcher.tick();
    expect(await runRow(queued?.id ?? '')).toMatchObject({
      status: 'errored',
      reason: 'offline',
      statusMessage: NODE_TIMEOUT_MESSAGE,
    });
    const audit = (await auditsOf(queued?.id ?? '')).find((a) => a.action === 'check.error');
    expect(audit).toMatchObject({ actorType: 'system', actorLabel: 'check-dispatcher' });

    // A run left running by a node gone that long (its offline report was lost to a restart).
    const stuck = await runningRun(app.id, node);
    await dispatcher.tick();
    expect(await runRow(stuck.id)).toMatchObject({
      status: 'errored',
      reason: 'offline',
      statusMessage: NODE_OFFLINE_MESSAGE,
    });
  });

  it('errors the runs of a node whose agent does not run checks', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality, lint] });
    const sink = createCheckSink(deps);
    const running = await runningRun(app.id, node);
    const [queued] = await db
      .insert(checkRuns)
      .values({
        appId: app.id,
        nodeId: node,
        name: 'lint',
        command: 'npm run lint',
        service: 'dev',
        composeFiles: ['.devcontainer/compose.yaml'],
        timeoutMinutes: 30,
        commitSha: sha(unique('queued')),
        ref: 'main',
        trigger: 'manual',
      })
      .returning();
    // Agents that run checks always list their runs; a heartbeat without the list proves the
    // agent predates checks, so nothing on that node would ever run or report them.
    await sink.onHeartbeat(node, undefined);
    expect(await runRow(running.id)).toMatchObject({
      status: 'errored',
      reason: 'unsupported',
      statusMessage: UNSUPPORTED_AGENT_MESSAGE,
    });
    await until(async () => (await runRow(queued?.id ?? '')).status === 'errored');
    expect(await runRow(queued?.id ?? '')).toMatchObject({ reason: 'unsupported' });
    expect(gateway.checkRuns.filter((r) => r.payload.runId === queued?.id)).toEqual([]);

    // A new connection may be an upgraded agent: it is asked again.
    await sink.onNodeOnline(node);
    const [next] = await createRuns(app.id, { ref: 'main', names: ['quality'] });
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === next?.id));
  });

  it('reconciles the runs a node reports in its heartbeats', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality] });
    const sink = createCheckSink(deps);
    const run = await runningRun(app.id, node, new Date(Date.now() - 60_000));

    // Left out of two heartbeats in a row: its result was lost.
    await sink.onHeartbeat(node, []);
    expect((await runRow(run.id)).status).toBe('running');
    await sink.onHeartbeat(node, []);
    expect(await runRow(run.id)).toMatchObject({
      status: 'errored',
      reason: 'lost',
      statusMessage: LOST_RUN_MESSAGE,
    });

    // Runs the node lists that do not run here are cancelled there; queued ones are kept.
    const [queued] = await createRuns(app.id, { ref: 'main' });
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === queued?.id));
    await db
      .update(checkRuns)
      .set({ status: 'queued', startedAt: null })
      .where(eq(checkRuns.id, queued?.id as CheckRunId));
    const stray = generateId('chk');
    await sink.onHeartbeat(node, [stray, run.id, queued?.id as CheckRunId]);
    await until(() => gateway.checkCancels.some((c) => c.runId === stray));
    expect(gateway.checkCancels.filter((c) => c.nodeId === node).map((c) => c.runId)).toEqual([
      stray,
      run.id,
    ]);

    // A run reported again is no longer counted as missing.
    const fresh = await db
      .update(checkRuns)
      .set({ status: 'running', startedAt: new Date(Date.now() - 60_000) })
      .where(eq(checkRuns.id, queued?.id as CheckRunId))
      .returning();
    await sink.onHeartbeat(node, []);
    await sink.onHeartbeat(node, [queued?.id as CheckRunId]);
    await sink.onHeartbeat(node, []);
    expect((await runRow(fresh[0]?.id ?? '')).status).toBe('running');

    // The node is gone: its running runs error.
    await sink.onNodeOffline(node);
    expect(await runRow(queued?.id ?? '')).toMatchObject({
      status: 'errored',
      reason: 'offline',
      statusMessage: NODE_OFFLINE_MESSAGE,
    });
  });

  it('cancels a running run through its node, or here when the node is gone', async () => {
    const node = await newNode(true);
    const { app } = await createTestApp(node, { items: [quality, lint] });
    const sink = createCheckSink(deps);
    await createRuns(app.id, { ref: 'main' });
    await until(async () => (await runsOf(app.id)).some((r) => r.status === 'running'));
    const first = (await runsOf(app.id)).find((r) => r.status === 'running');
    // The agent answers the cancel with the run's result.
    gateway.onCancelCheck = async (nodeId, runId) => {
      await sink.onResult(nodeId, { runId, reason: 'cancelled', exitCode: null });
    };
    const res = await api.request(`/api/v1/checks/${first?.id}/cancel`, json('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', statusMessage: 'Cancelled' });
    gateway.onCancelCheck = undefined;
    expect((await auditsOf(first?.id ?? '')).map((a) => [a.action, a.actorType])).toEqual([
      ['check.create', 'user'],
      ['check.cancel', 'agent'],
      ['check.cancel', 'user'],
    ]);

    // The next run went to the node; without an answer yet the run shows the request.
    await until(async () => (await runsOf(app.id)).some((r) => r.status === 'running'));
    const second = (await runsOf(app.id)).find((r) => r.status === 'running');
    const pending = await api.request(`/api/v1/checks/${second?.id}/cancel`, json('POST'));
    expect(await pending.json()).toMatchObject({
      status: 'running',
      statusMessage: CANCEL_REQUESTED_MESSAGE,
    });
    await sink.onResult(node, {
      runId: second?.id as CheckRunId,
      reason: 'cancelled',
      exitCode: null,
    });
    expect(await runRow(second?.id ?? '')).toMatchObject({
      status: 'cancelled',
      statusMessage: 'Cancelled',
    });

    // Put back in the queue meanwhile (its node went away before it was sent): cancelled there.
    const [third] = await createRuns(app.id, { ref: 'main', names: ['quality'] });
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === third?.id));
    gateway.onCancelCheck = async (nodeId, runId) => {
      await db
        .update(checkRuns)
        .set({ status: 'queued', startedAt: null })
        .where(eq(checkRuns.id, runId));
      throw new AgentUnavailableError(nodeId);
    };
    const requeued = await api.request(`/api/v1/checks/${third?.id}/cancel`, json('POST'));
    expect(await requeued.json()).toMatchObject({
      status: 'cancelled',
      statusMessage: 'Cancelled',
    });
    gateway.onCancelCheck = undefined;

    // The node is gone: cancelled here.
    const [fourth] = await createRuns(app.id, { ref: 'main', names: ['quality'] });
    await until(() => gateway.checkRuns.some((r) => r.payload.runId === fourth?.id));
    gateway.disconnect(node);
    const offline = await api.request(`/api/v1/checks/${fourth?.id}/cancel`, json('POST'));
    expect(await offline.json()).toMatchObject({ status: 'cancelled', statusMessage: 'Cancelled' });
  });
});

describe('checks over the agent socket', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  let gateway: NodeAgentGateway;
  let server: Awaited<ReturnType<typeof startTestServer>>;
  const github = new FakeGitHub();
  const admin = testPrincipal('admin');
  const ghAppId = randomInt(100_000, 999_999_999);
  const installationId = randomInt(100_000, 999_999_999);
  const connectionId = generateId('gh');
  const agents: TestAgent[] = [];

  async function runRow(id: string) {
    const [row] = await db
      .select()
      .from(checkRuns)
      .where(eq(checkRuns.id, id as CheckRunId));
    if (!row) throw new Error(`no check run ${id}`);
    return row;
  }

  /** A node joined over the socket by a scripted agent. */
  async function joinNode(): Promise<{ nodeId: NodeId; agent: TestAgent }> {
    const res = await api.request('/api/v1/nodes', json('POST', { name: unique('sock') }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreatedNode;
    const agent = await TestAgent.connect(server.url, created.joinToken.token);
    agents.push(agent);
    await agent.handshake();
    return { nodeId: created.node.id, agent };
  }

  async function appOn(nodeId: NodeId, items: CheckItemInput[]): Promise<App> {
    const repo = unique('socket');
    github.addRepo({ owner: 'octo', name: repo, branches: { main: sha(`${repo}-main`) } });
    const res = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: unique('App'),
        connectionId,
        repository: { owner: 'octo', name: repo },
        nodeId,
      }),
    );
    expect(res.status).toBe(201);
    const app = (await res.json()) as App;
    const patched = await api.request(
      `/api/v1/apps/${app.id}`,
      json('PATCH', { checks: { items } }),
    );
    expect(patched.status).toBe(200);
    return app;
  }

  async function queue(appId: string, body: unknown = { ref: 'main' }): Promise<CheckRun[]> {
    const res = await api.request(`/api/v1/apps/${appId}/checks`, json('POST', body));
    expect(res.status).toBe(201);
    return ((await res.json()) as CheckRunList).items;
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    const base = createTestDeps({ db, auth: fixedAuth(admin) });
    // Wired like src/server.ts, with short timeouts.
    const checks = createDeferredCheckSink();
    gateway = createAgentGateway({
      deps: base,
      sink: noopDeploymentSink,
      checks: checks.sink,
      timeouts: { checkAckMs: 300, offlineGraceMs: 100 },
    });
    deps = { ...base, agents: gateway };
    checks.bind(createCheckSink(deps));
    api = createApp(deps);
    await db.insert(users).values({
      id: admin.user.id,
      email: `${unique('admin')}@example.com`,
      name: 'Admin',
      role: 'admin',
    });
    github.apps.set(ghAppId, {
      id: ghAppId,
      slug: `launchway-socket-${ghAppId}`,
      webhookSecret: 'whsec',
      privateKey: testPrivateKey(),
      installations: new Map([[installationId, { login: 'octo', type: 'User' }]]),
    });
    await db.insert(githubConnections).values({
      id: connectionId,
      kind: 'app',
      name: unique('GitHub App'),
      accountLogin: 'octo',
      accountType: 'User',
      appId: ghAppId,
      appSlug: `launchway-socket-${ghAppId}`,
      privateKeyEncrypted: deps.secrets.encrypt(
        testPrivateKey(),
        secretContext.privateKey(connectionId),
      ),
      webhookSecretEncrypted: deps.secrets.encrypt(
        'whsec',
        secretContext.webhookSecret(connectionId),
      ),
      installationId,
    });
    await gateway.start();
    server = await startTestServer(deps);
  });

  afterAll(async () => {
    for (const agent of agents) agent.close();
    gateway.stop();
    await server.close();
    deps.lifecycle.beginShutdown();
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('errors the runs of an agent without checks once its heartbeat shows it', async () => {
    const { nodeId, agent } = await joinNode();
    const app = await appOn(nodeId, [quality, lint]);
    const runs = await queue(app.id);
    const first = await agent.next('check.run');
    // No answer, as from an agent older than checks: the run waits for the heartbeats.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await runRow(first.payload.runId)).status).toBe('running');
    // Its heartbeat has no activeCheckRunIds: that agent runs no checks.
    agent.heartbeat();
    for (const run of runs) {
      await until(async () => (await runRow(run.id)).status === 'errored');
      expect(await runRow(run.id)).toMatchObject({
        reason: 'unsupported',
        statusMessage: UNSUPPORTED_AGENT_MESSAGE,
      });
    }
    // Nothing more is sent to that agent.
    await expect(agent.next('check.run', 500)).rejects.toThrow(/no check.run message/);
  });

  it('sends a run again that a current agent never acknowledged nor got', async () => {
    const { nodeId, agent } = await joinNode();
    const app = await appOn(nodeId, [quality]);
    const [run] = await queue(app.id);
    const runId = run?.id as CheckRunId;
    await agent.next('check.run');
    // The answer is lost (a dropped link): the run stays sent until the heartbeats tell.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await runRow(runId)).status).toBe('running');
    await db
      .update(checkRuns)
      .set({ startedAt: new Date(Date.now() - 60_000) })
      .where(eq(checkRuns.id, runId));
    agent.heartbeat([], []);
    agent.heartbeat([], []);
    const second = await agent.next('check.run', 5_000);
    expect(second.payload.runId).toBe(runId);

    // A current agent acknowledges at once, streams the output and reports the result.
    agent.acknowledgeCheck(second);
    agent.send('check.log', { runId, lines: [line(0, 'all good')] }, second.id);
    agent.send('check.result', { runId, reason: 'exit', exitCode: 0 }, second.id);
    await until(async () => (await runRow(runId)).status === 'succeeded');
    const lines = await db
      .select({ seq: checkLogLines.seq, stream: checkLogLines.stream, line: checkLogLines.line })
      .from(checkLogLines)
      .where(eq(checkLogLines.runId, runId))
      .orderBy(asc(checkLogLines.seq));
    expect(lines).toEqual([
      { seq: 0, stream: 'system', line: 'Received by the node' },
      { seq: 1, stream: 'stdout', line: 'all good' },
    ]);
  });

  it('cancels a running run through its agent', async () => {
    const { nodeId, agent } = await joinNode();
    const app = await appOn(nodeId, [quality]);
    const [run] = await queue(app.id);
    const runId = run?.id as CheckRunId;
    const request = await agent.next('check.run');
    agent.acknowledgeCheck(request);
    await until(async () => (await runRow(runId)).status === 'running');

    const cancelling = api.request(`/api/v1/checks/${runId}/cancel`, json('POST'));
    const cancel = await agent.next('check.cancel');
    expect(cancel.payload).toEqual({ runId });
    // The agent answers with the run's result, echoing the id of check.run.
    agent.send('check.result', { runId, reason: 'cancelled', exitCode: null }, request.id);
    expect((await cancelling).status).toBe(200);
    await until(async () => (await runRow(runId)).status === 'cancelled');
    expect(await runRow(runId)).toMatchObject({ reason: 'cancelled', statusMessage: 'Cancelled' });
  });

  it('cancels runs the node should not run and errors runs it lost', async () => {
    const { nodeId, agent } = await joinNode();
    const app = await appOn(nodeId, [quality]);
    const [run] = await queue(app.id);
    const runId = run?.id as CheckRunId;
    const request = await agent.next('check.run');
    agent.acknowledgeCheck(request);
    await db
      .update(checkRuns)
      .set({ startedAt: new Date(Date.now() - 60_000) })
      .where(eq(checkRuns.id, runId));
    const stray = generateId('chk');
    agent.heartbeat([], [stray]);
    const cancel = await agent.next('check.cancel');
    expect(cancel.payload).toEqual({ runId: stray });
    agent.send(
      'error',
      { code: 'not-found', message: 'No queued or running check run', retryable: false },
      cancel.id,
    );
    agent.heartbeat([], []);
    await until(async () => (await runRow(runId)).status === 'errored');
    expect(await runRow(runId)).toMatchObject({ reason: 'lost', statusMessage: LOST_RUN_MESSAGE });
  });

  it('errors the running run of a node that goes away', async () => {
    const { nodeId, agent } = await joinNode();
    const app = await appOn(nodeId, [quality]);
    const [run] = await queue(app.id);
    const runId = run?.id as CheckRunId;
    const request = await agent.next('check.run');
    agent.acknowledgeCheck(request);
    await until(async () => (await runRow(runId)).status === 'running');
    agent.close();
    await until(async () => (await runRow(runId)).status === 'errored');
    expect(await runRow(runId)).toMatchObject({
      reason: 'offline',
      statusMessage: NODE_OFFLINE_MESSAGE,
    });
  });
});
