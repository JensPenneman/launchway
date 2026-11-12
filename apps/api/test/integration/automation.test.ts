import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  type App,
  type AppAutomationSettings,
  type AutomationRun,
  DEFAULT_APP_AUTOMATION_SETTINGS,
  DEFAULT_APP_CHECKS_SETTINGS,
  generateId,
  type NodeId,
} from '@launchway/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import {
  apps,
  auditEvents,
  automationRuns,
  checkRuns,
  githubConnections,
  nodes,
  settings,
  users,
} from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { type Principal, systemActor } from '../../src/lib/auth-context.js';
import {
  createAutomationService,
  LOCK_POOL_OPTIONS,
} from '../../src/modules/automation/service.js';
import { secretContext } from '../../src/modules/github/providers.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import {
  type FakeAutomationPull,
  FakeGitHub,
  type FakePull,
  sha,
  testPrivateKey,
} from '../support/fake-github.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

let counter = 0;
const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

async function until(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const BASE_MANIFEST = JSON.stringify({
  name: 'x',
  scripts: { check: 'true' },
  dependencies: { x: '1.0.0' },
});
const headManifest = (version: string) =>
  JSON.stringify({ name: 'x', scripts: { check: 'true' }, dependencies: { x: version } });

describe('Dependabot auto-merge against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  let api: ReturnType<typeof createApp>;
  const github = new FakeGitHub();
  const admin = testPrincipal('admin');
  const ghAppId = randomInt(100_000, 999_999_999);
  const installationId = randomInt(100_000, 999_999_999);
  const webhookSecret = randomBytes(16).toString('hex');
  const connectionId = generateId('gh');
  const slug = `launchway-auto-${ghAppId}`;
  const botLogin = `${slug}[bot]`;
  let nodeId: NodeId;

  function webhook(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': crypto.randomUUID(),
        'x-github-hook-installation-target-type': 'integration',
        'x-github-hook-installation-target-id': String(ghAppId),
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
      },
      body,
    };
  }

  const deliver = (event: string, payload: unknown) =>
    api.request('/api/v1/webhooks/github', webhook(event, payload));

  interface Fixture {
    app: App;
    repo: string;
    pull(number: number, options?: PullOptions): { head: string; number: number };
    /** The fake's pull request, to change what GitHub reports. */
    repoPull(number: number): FakePull;
  }
  interface PullOptions {
    head?: string;
    files?: string[];
    auto?: FakeAutomationPull;
    title?: string;
  }

  async function createFixture(
    automation: Partial<AppAutomationSettings> = { merge: 'on' },
  ): Promise<Fixture> {
    const repo = github.addRepo({
      owner: 'octo',
      name: unique('repo'),
      branches: { main: sha('main') },
      pulls: {},
    });
    const res = await api.request(
      '/api/v1/apps',
      json('POST', {
        name: unique('App'),
        connectionId,
        repository: { owner: repo.owner, name: repo.name },
        nodeId,
      }),
    );
    expect(res.status).toBe(201);
    const app = (await res.json()) as App;
    await db
      .update(apps)
      .set({
        checks: {
          ...DEFAULT_APP_CHECKS_SETTINGS,
          enabled: true,
          items: [
            { name: 'quality', command: 'npm run check', service: 'dev', timeoutMinutes: 30 },
          ],
        },
        automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, ...automation },
      })
      .where(eq(apps.id, app.id));
    // Main is green: its head has a succeeded run of every configured check.
    await insertCheck(
      { app, repo: repo.name } as Fixture,
      sha('main'),
      'succeeded',
      new Date(Date.now() - 60_000),
    );
    return {
      app,
      repo: repo.name,
      repoPull(number) {
        const pull = repo.pulls?.[number];
        if (!pull) throw new Error(`no pull request ${number}`);
        return pull;
      },
      pull(number, options = {}) {
        const head = options.head ?? sha(`head-${repo.name}-${number}`);
        const baseSha = sha('base');
        repo.pulls = {
          ...repo.pulls,
          [number]: {
            title: options.title ?? `Bump x from 1.0.0 to 1.0.1`,
            headRef: `dependabot/npm_and_yarn/x-1.0.1`,
            headSha: head,
            auto: {
              baseSha,
              files: (options.files ?? ['package.json', 'package-lock.json']).map((filename) => ({
                filename,
              })),
              contents: {
                [`${baseSha}:package.json`]: BASE_MANIFEST,
                [`${head}:package.json`]: headManifest('1.0.1'),
              },
              commits: [
                {
                  sha: head,
                  message:
                    'Bump x from 1.0.0 to 1.0.1\n\n---\nupdated-dependencies:\n- dependency-name: x\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...\n',
                },
              ],
              ...options.auto,
            },
          },
        };
        return { head, number };
      },
    };
  }

  function pullRequestEvent(f: Fixture, action: string, number: number, head: string) {
    return {
      action,
      number,
      pull_request: {
        title: 'Bump x',
        state: 'open',
        user: { login: 'dependabot[bot]', type: 'Bot' },
        labels: [],
        head: {
          ref: 'dependabot/npm_and_yarn/x-1.0.1',
          sha: head,
          repo: { full_name: `octo/${f.repo}` },
        },
        base: { ref: 'main', repo: { full_name: `octo/${f.repo}` } },
      },
      repository: { name: f.repo, owner: { login: 'octo' }, default_branch: 'main' },
    };
  }

  /** Waits for the background classification the webhook started. */
  const settle = () => createAutomationService(deps).drain();

  async function deliverAndSettle(event: string, payload: unknown) {
    const res = await deliver(event, payload);
    await settle();
    return res;
  }

  async function runOf(f: Fixture, number: number): Promise<AutomationRun | undefined> {
    const [row] = await db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.key, `pr-${number}`)));
    return row as unknown as AutomationRun | undefined;
  }

  async function checksOf(f: Fixture) {
    return db
      .select()
      .from(checkRuns)
      .where(eq(checkRuns.appId, f.app.id))
      .orderBy(asc(checkRuns.createdAt));
  }

  async function insertCheck(
    f: Fixture,
    commitSha: string,
    status: 'failed' | 'errored' | 'succeeded',
    createdAt = new Date(),
  ) {
    const [row] = await db
      .insert(checkRuns)
      .values({
        appId: f.app.id,
        nodeId,
        name: 'quality',
        command: 'npm run check',
        service: 'dev',
        composeFiles: ['.devcontainer/compose.yaml'],
        timeoutMinutes: 30,
        commitSha,
        trigger: 'pull_request',
        status,
        reason: status === 'succeeded' ? 'exit' : status === 'failed' ? 'exit' : 'infrastructure',
        createdAt,
      })
      .returning({ id: checkRuns.id });
    return row?.id as string;
  }

  beforeAll(async () => {
    vi.stubGlobal('fetch', github.fetch);
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    deps = createTestDeps({ db, auth: fixedAuth(admin) });
    api = createApp(deps);
    await db.insert(users).values({
      id: admin.user.id,
      email: `${unique('admin')}@example.com`,
      name: 'Admin',
      role: 'admin',
    });
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    const [node] = await db
      .insert(nodes)
      .values({ name: unique('node'), status: 'online', lanIp: '192.168.1.41' })
      .returning({ id: nodes.id });
    nodeId = node?.id as NodeId;
    github.apps.set(ghAppId, {
      id: ghAppId,
      slug,
      webhookSecret,
      privateKey: testPrivateKey(),
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        statuses: 'write',
        checks: 'read',
        metadata: 'read',
        deployments: 'write',
      },
      installations: new Map([[installationId, { login: 'octo', type: 'User' }]]),
    });
    await db.insert(githubConnections).values({
      id: connectionId,
      kind: 'app',
      name: unique('GitHub App'),
      accountLogin: 'octo',
      accountType: 'User',
      appId: ghAppId,
      appSlug: slug,
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
    await pool.end();
    vi.unstubAllGlobals();
  });

  async function noticesOf(f: Fixture) {
    return db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.kind, 'notice')));
  }

  const notifications = (run: AutomationRun | undefined) =>
    (run?.actions ?? []).filter((a) => a.type === 'notify');

  const reconcile = () => createAutomationService(deps).reconcile();

  it('enables auto-merge pinned to the head, and records the run first', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(12);
    const before = github.automationWrites.length;
    const reads = github.writeTokenReads.length;
    const res = await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    expect(res.status).toBe(204);
    expect(github.automationWrites.slice(before)).toEqual([
      `enablePullRequestAutoMerge #12 ${head}`,
    ]);
    // Reads use the read token; the write token only writes (the fake refuses a write without it).
    expect(github.writeTokenReads.slice(reads)).toEqual([]);
    const run = await runOf(f, number);
    expect(run?.state).toBe('auto-merge-enabled');
    expect(run?.snapshot).toMatchObject({
      headSha: head,
      verdict: { verdict: 'eligible' },
      appEnabled: true,
    });
    expect(run?.actions.map((a) => [a.type, a.status])).toEqual([
      ['github.enableAutoMerge', 'done'],
      ['recordState', 'done'],
    ]);
    // The run was recorded before the checks of the head were queued.
    const queued = (await checksOf(f)).find((c) => c.commitSha === head);
    expect(queued).toBeDefined();
    const row = (
      await db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, run?.id as never))
    )[0];
    expect(row?.createdAt.getTime()).toBeLessThanOrEqual(queued?.createdAt.getTime() ?? 0);
    const audited = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'automation.auto-merge.enable'));
    expect(audited.length).toBeGreaterThan(0);
  });

  it('repeating a delivery repeats no write and queues the checks once', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(13);
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    const writes = github.automationWrites.length;
    expect(
      (await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', number, head)))
        .status,
    ).toBe(204);
    expect(github.automationWrites.length).toBe(writes);
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
  });

  it('merges through REST with the head sha when GitHub answers "clean status"', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(14, { auto: { enableAnswer: 'clean-status' } });
    await insertCheck(f, head, 'succeeded');
    const before = github.automationWrites.length;
    expect(
      (await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head))).status,
    ).toBe(204);
    expect(github.automationWrites.slice(before)).toEqual([
      `enablePullRequestAutoMerge #14 ${head}`,
      `merge #14 ${head} merge`,
    ]);
    const run = await runOf(f, number);
    expect(run?.state).toBe('merged');
    expect(run?.actions.map((a) => [a.type, a.status])).toEqual([
      ['github.enableAutoMerge', 'refused'],
      ['github.merge', 'done'],
      ['recordState', 'done'],
    ]);
  });

  it('a refused REST merge goes back to decide, is recorded, and is announced once per head', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(15, {
      auto: { enableAnswer: 'clean-status', mergeStatus: 409 },
    });
    await insertCheck(f, head, 'succeeded');
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    await reconcile();
    await reconcile();
    const run = await runOf(f, number);
    expect(run?.state).toBe('merge-refused');
    expect(run?.snapshot).toMatchObject({ reason: 'status-409' });
    expect(notifications(run).filter((a) => a.key === `notify:refused:${head}`)).toHaveLength(1);
  });

  it('retries a transient merge refusal at most three times, then announces it once', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(16, {
      auto: { enableAnswer: 'clean-status', mergeStatus: 405 },
    });
    await insertCheck(f, head, 'succeeded');
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    expect((await runOf(f, number))?.state).toBe('merge-retrying');
    for (let pass = 0; pass < 5; pass += 1) await reconcile();
    const run = await runOf(f, number);
    expect(run?.state).toBe('merge-refused');
    expect(github.automationWrites.filter((w) => w.startsWith(`merge #16 ${head}`))).toHaveLength(
      4,
    );
    expect(notifications(run).filter((a) => a.key === `notify:refused:${head}`)).toHaveLength(1);
  });

  it('announces an enable refused as unprocessable once, and does not retry it', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(17, {
      auto: { enableError: { type: 'UNPROCESSABLE', message: 'Pull request is not eligible' } },
    });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    await reconcile();
    const run = await runOf(f, number);
    expect(run?.state).toBe('auto-merge-refused');
    expect(
      github.automationWrites.filter((w) => w.startsWith('enablePullRequestAutoMerge #17')),
    ).toHaveLength(1);
    expect(notifications(run).filter((a) => a.key === `notify:refused:${head}`)).toHaveLength(1);
  });

  it('GraphQL RATE_LIMITED on enable is a failure that is retried, not a refusal', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(18, {
      auto: { enableError: { type: 'RATE_LIMITED', message: 'API rate limit exceeded' } },
    });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    expect((await runOf(f, number))?.actions.some((a) => a.type === 'github.enableAutoMerge')).toBe(
      false,
    );
    expect((await runOf(f, number))?.state).not.toBe('auto-merge-refused');
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toEqual([]);
    delete f.repoPull(number).auto?.enableError;
    await reconcile();
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
  });

  it('disables the App-enabled auto-merge of a new head before it classifies it', async () => {
    const f = await createFixture();
    const oldHead = sha('old-head');
    f.pull(19, { head: oldHead });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 19, oldHead));
    expect((await runOf(f, 19))?.snapshot).toMatchObject({ headSha: oldHead });

    // Dependabot force-pushes: the fake keeps the App's auto-merge on the pull request.
    const fresh = f.pull(19, { head: sha('new-head'), auto: { autoMergeBy: botLogin } });
    const start = github.calls.length;
    const writes = github.automationWrites.length;
    expect(
      (await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 19, fresh.head)))
        .status,
    ).toBe(204);
    const calls = github.calls.slice(start);
    expect(github.automationWrites.slice(writes)).toEqual([
      'disablePullRequestAutoMerge #19',
      `enablePullRequestAutoMerge #19 ${fresh.head}`,
    ]);
    // The disable (a GraphQL call) came before the classifier read the commits.
    expect(calls.indexOf('POST /graphql')).toBeLessThan(
      calls.findIndex((c) => c.endsWith('/pulls/19/commits')),
    );
    expect((await runOf(f, 19))?.snapshot).toMatchObject({ headSha: fresh.head });
  });

  it('a stale auto_merge field does not keep a recorded App enable on a new head', async () => {
    const f = await createFixture();
    f.pull(20, { head: sha('s-old') });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 20, sha('s-old')));
    // GitHub's field already reads null for the new head, but the run records an App enable.
    const fresh = f.pull(20, { head: sha('s-new'), auto: { files: [{ filename: 'x.yml' }] } });
    const writes = github.automationWrites.length;
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 20, fresh.head));
    expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #20']);
  });

  it('queues no check for a head whose classification failed; the reconcile queues them once', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(21);
    github.failRepoRequests = 100;
    const res = await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    github.failRepoRequests = 0;
    // The webhook records the head and returns: no failed delivery GitHub would never redeliver.
    expect(res.status).toBe(204);
    expect(await checksOf(f)).toEqual(
      (await checksOf(f)).filter((c) => c.commitSha === sha('main')),
    );
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toEqual([]);
    // No redelivery follows: the reconcile classifies the head and queues its checks, once.
    await reconcile();
    await reconcile();
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
  });

  it('holds the checks of a push to dependabot/* that has no pull request yet', async () => {
    const f = await createFixture();
    const head = sha('pushed');
    const push = () =>
      deliverAndSettle('push', {
        ref: 'refs/heads/dependabot/npm_and_yarn/x-1.0.1',
        after: head,
        before: sha('before'),
        head_commit: { id: head, tree_id: sha('tree') },
        sender: { login: 'dependabot[bot]', type: 'Bot' },
        repository: { name: f.repo, owner: { login: 'octo' }, default_branch: 'main' },
      });
    expect((await push()).status).toBe(204);
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toEqual([]);
    // With the pull request open, the push is classified like an opened event, then queued.
    f.pull(22, { head });
    await push();
    expect((await runOf(f, 22))?.state).toBe('auto-merge-enabled');
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
  });

  it('enables nothing for a head that changes a file outside the allowlist', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(23, { files: ['package.json', '.github/workflows/x.yml'] });
    const before = github.automationWrites.length;
    expect(
      (await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head))).status,
    ).toBe(204);
    expect(github.automationWrites.length).toBe(before);
    const run = await runOf(f, number);
    expect(run?.state).toBe('ineligible');
    expect(run?.snapshot).toMatchObject({ reason: expect.stringContaining('allowlist') });
  });

  it('makes no write call in shadow mode and records what it would do', async () => {
    const f = await createFixture({ merge: 'shadow' });
    const { head, number } = f.pull(24);
    const start = github.calls.length;
    expect(
      (await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head))).status,
    ).toBe(204);
    expect(
      github.calls
        .slice(start)
        .filter((c) => !c.startsWith('GET ') && !c.includes('access_tokens')),
    ).toEqual([]);
    expect(github.automationWrites.filter((w) => w.includes('#24'))).toEqual([]);
    expect((await runOf(f, number))?.state).toBe('shadow');
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
  });

  it('does nothing while the mode is off', async () => {
    const f = await createFixture({ merge: 'off' });
    const { head, number } = f.pull(25);
    expect(
      (await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head))).status,
    ).toBe(204);
    expect(await runOf(f, number)).toBeUndefined();
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
  });

  it('disables every App-enabled auto-merge and enables none while main is red', async () => {
    const f = await createFixture();
    const a = f.pull(30);
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 30, a.head));
    expect((await runOf(f, 30))?.state).toBe('auto-merge-enabled');

    await insertCheck(f, sha('main'), 'failed');
    f.pull(31);
    const writes = github.automationWrites.length;
    await reconcile();
    expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #30']);
    expect((await runOf(f, 30))?.state).toBe('main-red');
    expect((await runOf(f, 31))?.state).toBe('main-red');

    // Main recovers: the next pass enables them again, with new idempotency keys.
    await insertCheck(f, sha('main'), 'succeeded', new Date(Date.now() + 1_000));
    await reconcile();
    expect(
      github.automationWrites.filter((w) => w.startsWith('enablePullRequestAutoMerge #3')),
    ).toHaveLength(3);
    expect((await runOf(f, 30))?.state).toBe('auto-merge-enabled');
  });

  it('main pending enables nothing and tells nobody; main errored tells once per main sha', async () => {
    const f = await createFixture();
    await db.delete(checkRuns).where(eq(checkRuns.appId, f.app.id));
    f.pull(32);
    f.pull(33);
    const writes = github.automationWrites.length;
    await reconcile();
    expect(github.automationWrites.length).toBe(writes);
    expect((await runOf(f, 32))?.state).toBe('main-pending');
    expect(await noticesOf(f)).toEqual([]);

    await insertCheck(f, sha('main'), 'errored');
    await reconcile();
    await reconcile();
    expect(github.automationWrites.length).toBe(writes);
    expect((await runOf(f, 32))?.state).toBe('main-unknown');
    // Two pull requests, two passes: one notice for the app and main sha.
    const notices = await noticesOf(f);
    expect(notices.map((n) => n.key)).toEqual([`notice:main-unknown:${sha('main')}`]);
  });

  it('re-runs an errored check at most twice per head', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(40);
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    const erroredRuns = async () => (await checksOf(f)).filter((r) => r.commitSha === head);
    // The run the automation queued errors; each pass may re-run it, up to twice.
    for (let pass = 1; pass <= 4; pass += 1) {
      const runs = await erroredRuns();
      const newest = runs[runs.length - 1];
      await db
        .update(checkRuns)
        .set({ status: 'errored', reason: 'infrastructure', finishedAt: new Date() })
        .where(eq(checkRuns.id, newest?.id as never));
      await reconcile();
    }
    expect(await erroredRuns()).toHaveLength(3);
    const run = await runOf(f, number);
    expect(run?.actions.filter((a) => a.type === 'checks.rerun')).toHaveLength(2);
  });

  it('a refused re-run: a full queue is retried without counting; other refusals stop at five', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(41);
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    const [queued] = (await checksOf(f)).filter((r) => r.commitSha === head);
    await db
      .update(checkRuns)
      .set({ status: 'errored', reason: 'infrastructure', finishedAt: new Date() })
      .where(eq(checkRuns.id, queued?.id as never));

    // A full queue: refused again and again, never counted, never announced.
    await db.update(settings).set({ checkMaxQueuedPerApp: 0 }).where(eq(settings.id, 1));
    try {
      for (let pass = 0; pass < 3; pass += 1) await reconcile();
      let run = await runOf(f, number);
      const reruns = run?.actions.filter((a) => a.type === 'checks.rerun') ?? [];
      expect(reruns).toHaveLength(1);
      expect(reruns[0]).toMatchObject({ status: 'refused', result: { transient: true } });
      expect(notifications(run).some((a) => a.key === `notify:errored:${head}`)).toBe(false);

      // The check item is removed: every attempt is refused for good; after five, one ntfy.
      await db.update(settings).set({ checkMaxQueuedPerApp: 30 }).where(eq(settings.id, 1));
      await db
        .update(apps)
        .set({ checks: { ...DEFAULT_APP_CHECKS_SETTINGS, enabled: true, items: [] } })
        .where(eq(apps.id, f.app.id));
      await reconcile();
      await reconcile();
      run = await runOf(f, number);
      expect(
        (run?.actions ?? []).filter((a) => a.type === 'checks.rerun' && a.status === 'refused'),
      ).toHaveLength(5);
      expect(notifications(run).filter((a) => a.key === `notify:errored:${head}`)).toHaveLength(1);
    } finally {
      await db.update(settings).set({ checkMaxQueuedPerApp: 30 }).where(eq(settings.id, 1));
    }
  });

  it('re-classifies an eligible head when the policy is tightened, the base moves or it becomes a draft', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(42);
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');

    // allowedPaths tightened: no event, the next pass notices.
    await db
      .update(apps)
      .set({
        automation: {
          ...DEFAULT_APP_AUTOMATION_SETTINGS,
          merge: 'on',
          allowedPaths: ['package.json'],
        },
      })
      .where(eq(apps.id, f.app.id));
    let writes = github.automationWrites.length;
    await reconcile();
    expect((await runOf(f, number))?.state).toBe('ineligible');
    expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #42']);

    // Back to the default policy; the verdict returns to eligible.
    await db
      .update(apps)
      .set({ automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, merge: 'on' } })
      .where(eq(apps.id, f.app.id));
    await reconcile();
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');

    // The base is retargeted (`edited`).
    f.repoPull(number).auto = { ...f.repoPull(number).auto, baseRef: 'release' };
    writes = github.automationWrites.length;
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'edited', number, head));
    expect((await runOf(f, number))?.state).toBe('ineligible');
    expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #42']);

    // Back on the default branch, then converted to a draft.
    f.repoPull(number).auto = { ...f.repoPull(number).auto, baseRef: 'main' };
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'edited', number, head));
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
    f.repoPull(number).auto = { ...f.repoPull(number).auto, draft: true };
    writes = github.automationWrites.length;
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'converted_to_draft', number, head));
    expect((await runOf(f, number))?.state).toBe('ineligible');
    expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #42']);
  });

  it('an incomplete file list right after opened becomes eligible on the next pass', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(43, { auto: { changedFiles: 3 } });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    expect((await runOf(f, number))?.state).toBe('classification-pending');
    expect(github.automationWrites.filter((w) => w.includes('#43'))).toEqual([]);
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toEqual([]);
    f.repoPull(number).auto = { ...f.repoPull(number).auto, changedFiles: 2 };
    await reconcile();
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
  });

  /** Pretends the head was first seen `minutes` ago. */
  const seenAgo = (f: Fixture, number: number, minutes: number) =>
    db
      .update(automationRuns)
      .set({
        snapshot:
          sql`jsonb_set(${automationRuns.snapshot}, '{firstSeenAt}', ${JSON.stringify(new Date(Date.now() - minutes * 60_000).toISOString())}::jsonb)` as never,
      })
      .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.key, `pr-${number}`)));

  it('gives up on an incomplete list only ten minutes after the head was first seen', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(44, { auto: { changedFiles: 3 } });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    // Quick successive reads (push, synchronize, reconcile) do not use the patience up.
    for (let pass = 0; pass < 4; pass += 1) await reconcile();
    expect((await runOf(f, number))?.state).toBe('classification-pending');
    await seenAgo(f, number, 11);
    await reconcile();
    expect((await runOf(f, number))?.state).toBe('ineligible');
  });

  it('three quick incomplete reads, then a complete one three minutes later: eligible', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(45, { auto: { changedFiles: 3 } });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    await reconcile();
    await reconcile();
    await seenAgo(f, number, 3);
    f.repoPull(number).auto = { ...f.repoPull(number).auto, changedFiles: 2 };
    await reconcile();
    expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
  });

  it('clean status without every check succeeded on the head: no REST merge, one ntfy', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(45, { auto: { enableAnswer: 'clean-status' } });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    await reconcile();
    const run = await runOf(f, number);
    expect(run?.state).toBe('clean-without-checks');
    expect(github.automationWrites.filter((w) => w.startsWith('merge #45'))).toEqual([]);
    expect(
      notifications(run).filter((a) => a.key === `notify:clean-without-checks:${head}`),
    ).toHaveLength(1);
    // Once the check has succeeded for the head, the merge goes through.
    await db
      .update(checkRuns)
      .set({ status: 'succeeded', reason: 'exit', finishedAt: new Date() })
      .where(and(eq(checkRuns.appId, f.app.id), eq(checkRuns.commitSha, head)));
    await reconcile();
    expect(github.automationWrites.filter((w) => w.startsWith('merge #45'))).toHaveLength(1);
  });

  it('keeps the conflict timer while GitHub recomputes, and resets it on a definite answer', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(46, { auto: { mergeableState: 'dirty' } });
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    const since = (await runOf(f, number))?.snapshot.conflictSince;
    expect(typeof since).toBe('string');
    f.repoPull(number).auto = { ...f.repoPull(number).auto, mergeableState: 'unknown' };
    await reconcile();
    expect((await runOf(f, number))?.snapshot.conflictSince).toBe(since);
    f.repoPull(number).auto = { ...f.repoPull(number).auto, mergeableState: 'clean' };
    await reconcile();
    expect((await runOf(f, number))?.snapshot.conflictSince).toBeNull();
  });

  describe('a head that is not the one the payload names', () => {
    it('API newer than the payload: nothing is queued for the payload sha, the auto-merge goes off', async () => {
      const f = await createFixture();
      f.pull(47, { head: sha('x-1') });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 47, sha('x-1')));
      const api = f.pull(47, { head: sha('x-api'), auto: { autoMergeBy: botLogin } });
      const writes = github.automationWrites.length;
      await deliverAndSettle(
        'pull_request',
        pullRequestEvent(f, 'synchronize', 47, sha('x-payload')),
      );
      expect(github.automationWrites.slice(writes)[0]).toBe('disablePullRequestAutoMerge #47');
      const queued = (await checksOf(f)).map((c) => c.commitSha);
      expect(queued).not.toContain(sha('x-payload'));
      expect(queued).not.toContain(api.head);
      // The event of the head the API reports queues it.
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 47, api.head));
      expect((await checksOf(f)).map((c) => c.commitSha)).toContain(api.head);
    });

    it('API stale: the checks wait until the API shows the head, then the reconcile queues them', async () => {
      const f = await createFixture();
      f.pull(48, { head: sha('y-old'), auto: { autoMergeBy: botLogin } });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 48, sha('y-old')));
      const writes = github.automationWrites.length;
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 48, sha('y-new')));
      expect((await checksOf(f)).map((c) => c.commitSha)).not.toContain(sha('y-new'));
      expect(github.automationWrites.slice(writes).every((w) => !w.includes('y-new'))).toBe(true);
      f.pull(48, { head: sha('y-new') });
      await reconcile();
      expect((await checksOf(f)).filter((c) => c.commitSha === sha('y-new'))).toHaveLength(1);
    });
  });

  it('pins the lists to the head: a push between the reads fails the pass', async () => {
    const f = await createFixture();
    const { head, number } = f.pull(49);
    const gate = github.gate(/GET .*\/pulls\/49\/files/);
    await deliver('pull_request', pullRequestEvent(f, 'opened', number, head));
    await gate.entered;
    f.pull(49, { head: sha('moved') });
    gate.release();
    await settle();
    expect((await runOf(f, number))?.snapshot.verdict ?? null).toBeNull();
    expect((await checksOf(f)).filter((c) => c.commitSha === head)).toEqual([]);
    // The reconcile of later tests would retry this pass; the app is switched off for them.
    await db
      .update(apps)
      .set({ automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, merge: 'off' } })
      .where(eq(apps.id, f.app.id));
  });

  it('records a notification and sends it after the handler, never inline', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: string[] = [];
    const sink: Server = createServer((req, res) => {
      received.push(`${req.headers.title}|${req.headers.click}`);
      void hold.then(() => res.end('ok'));
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const port = (sink.address() as { port: number }).port;
    await db
      .update(settings)
      .set({ notifyUrl: `http://127.0.0.1:${port}/trail` })
      .where(eq(settings.id, 1));
    try {
      const f = await createFixture();
      const { head, number } = f.pull(50);
      await insertCheck(f, head, 'failed');
      const started = Date.now();
      const res = await deliver('pull_request', pullRequestEvent(f, 'opened', number, head));
      expect(res.status).toBe(204);
      await settle();
      // The sink answers only when released: neither the webhook nor the handle waited for it.
      expect(Date.now() - started).toBeLessThan(2_500);
      const run = await runOf(f, number);
      expect(run?.actions.some((a) => a.type === 'notify')).toBe(true);
      await until(async () => received.length === 1);
      expect(received[0]).toContain('Dependabot checks failed');
      release();
      await until(async () =>
        ((await runOf(f, number))?.actions ?? []).some(
          (a) => a.type === 'notify' && a.result?.detail === 'delivered',
        ),
      );
      // One notification per head: another delivery sends nothing more.
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', number, head));
      await createAutomationService(deps).flushPending();
      expect(received).toHaveLength(1);
    } finally {
      release();
      sink.closeAllConnections();
      await new Promise((resolve) => sink.close(resolve));
      await db.update(settings).set({ notifyUrl: null }).where(eq(settings.id, 1));
    }
  });

  it('sends a pending notification once even when two service instances claim it at once', async () => {
    const received: string[] = [];
    const sink: Server = createServer((req, res) => {
      received.push(String(req.headers.title));
      res.end('ok');
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const port = (sink.address() as { port: number }).port;
    await db
      .update(settings)
      .set({ notifyUrl: `http://127.0.0.1:${port}/trail` })
      .where(eq(settings.id, 1));
    try {
      const f = await createFixture();
      await db.insert(automationRuns).values({
        appId: f.app.id,
        kind: 'pr',
        key: 'pr-90',
        state: 'new',
        snapshot: {},
        actions: [
          {
            type: 'notify',
            key: 'notify:test',
            input: { title: 'Claimed once', priority: 'low', tags: [], body: 'x', click: null },
            status: 'pending',
            result: null,
          },
        ],
      });
      await Promise.all([
        createAutomationService(deps).flushPending(),
        createAutomationService(deps).flushPending(),
        createAutomationService(deps).flushPending(),
      ]);
      await until(async () => received.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toEqual(['Claimed once']);
    } finally {
      sink.closeAllConnections();
      await new Promise((resolve) => sink.close(resolve));
      await db.update(settings).set({ notifyUrl: null }).where(eq(settings.id, 1));
    }
  });

  it('shadow notifications are marked and quiet', async () => {
    const f = await createFixture({ merge: 'shadow' });
    const { head, number } = f.pull(51);
    await insertCheck(f, head, 'failed');
    await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
    const [note] = notifications(await runOf(f, number));
    expect(note?.input).toMatchObject({
      title: '[shadow] Dependabot checks failed',
      priority: 'min',
    });
  });

  describe('PUT /apps/{id}/automation and the pause', () => {
    const tokenPrincipal: Principal = {
      kind: 'token',
      tokenId: generateId('tok'),
      scopes: ['admin'],
      user: admin.user,
    };
    const writeToken: Principal = { ...tokenPrincipal, scopes: ['write'] };
    const asPrincipal = (principal: Principal) =>
      createApp(createTestDeps({ db, secrets: deps.secrets, auth: fixedAuth(principal) }));
    const putUrl = (f: Fixture) => `/api/v1/apps/${f.app.id}/automation`;
    const pauseUrl = (f: Fixture) => `${putUrl(f)}/pause`;

    async function enabledPull(f: Fixture, number: number) {
      const { head } = f.pull(number);
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
      expect((await runOf(f, number))?.snapshot).toMatchObject({ appEnabled: true });
      return head;
    }

    it('refuses tokens and password sessions, accepts a passkey session', async () => {
      const f = await createFixture({ merge: 'off' });
      const url = putUrl(f);
      expect(
        (await asPrincipal(tokenPrincipal).request(url, json('PUT', { merge: 'on' }))).status,
      ).toBe(403);
      const password = testPrincipal('admin', 'password');
      expect((await asPrincipal(password).request(url, json('PUT', { merge: 'on' }))).status).toBe(
        403,
      );
      expect((await api.request(url, json('PUT', { merge: 'on', paused: false }))).status).toBe(
        200,
      );
      const body = (await (await api.request(`/api/v1/apps/${f.app.id}`)).json()) as App;
      expect(body.automation).toMatchObject({ merge: 'on', paused: false });
      expect((await api.request(url, json('PUT', { merge: 'maybe' }))).status).toBe(400);
      const audited = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'app.automation.update'));
      expect(audited.length).toBeGreaterThan(0);
    });

    it('on to off: the PUT returns only after the disable, and reports the pull request confirmed', async () => {
      const f = await createFixture();
      await enabledPull(f, 61);
      const writes = github.automationWrites.length;
      const res = await api.request(putUrl(f), json('PUT', { merge: 'off' }));
      expect(res.status).toBe(200);
      expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #61']);
      expect(await res.json()).toMatchObject({
        merge: 'off',
        sweep: { confirmed: [61], failed: [] },
      });
      expect((await runOf(f, 61))?.snapshot).toMatchObject({ appEnabled: false });
    });

    it('on to shadow: disabled before the PUT returns; shadow then enables, merges and re-runs nothing', async () => {
      const f = await createFixture();
      const head = await enabledPull(f, 62);
      const writes = github.automationWrites.length;
      const res = await api.request(putUrl(f), json('PUT', { merge: 'shadow' }));
      expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #62']);
      expect(await res.json()).toMatchObject({ sweep: { confirmed: [62], failed: [] } });
      const [queued] = (await checksOf(f)).filter((c) => c.commitSha === head);
      await db
        .update(checkRuns)
        .set({ status: 'errored', reason: 'infrastructure', finishedAt: new Date() })
        .where(eq(checkRuns.id, queued?.id as never));
      const after = github.automationWrites.length;
      const runs = (await checksOf(f)).length;
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 62, head));
      await reconcile();
      expect(github.automationWrites.slice(after)).toEqual([]);
      expect((await checksOf(f)).length).toBe(runs);
    });

    for (const mode of ['off', 'shadow'] as const) {
      it(`${mode}: a new head with an App-enabled auto-merge is disabled before its checks are queued`, async () => {
        const f = await createFixture();
        await enabledPull(f, mode === 'off' ? 63 : 64);
        const number = mode === 'off' ? 63 : 64;
        // The mode changes without the sweep (a direct write), as when the sweep failed.
        await db
          .update(apps)
          .set({ automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, merge: mode } })
          .where(eq(apps.id, f.app.id));
        const fresh = f.pull(number, { head: sha(`${mode}-new`), auto: { autoMergeBy: botLogin } });
        const gate = github.gate(/POST \/graphql/);
        await deliver('pull_request', pullRequestEvent(f, 'synchronize', number, fresh.head));
        await gate.entered;
        // The disable is in flight: no check exists for the new head yet.
        expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toEqual([]);
        gate.release();
        await settle();
        expect(github.automationWrites.at(-1)).toBe(`disablePullRequestAutoMerge #${number}`);
        expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toHaveLength(1);
        expect(
          github.automationWrites.filter((w) =>
            w.startsWith(`enablePullRequestAutoMerge #${number} ${fresh.head}`),
          ),
        ).toEqual([]);
      });
    }

    it('lets a write-scope token pause; the disable is done when the response arrives', async () => {
      const f = await createFixture();
      await enabledPull(f, 65);
      const writes = github.automationWrites.length;
      const res = await asPrincipal(writeToken).request(pauseUrl(f), json('POST'));
      expect(res.status).toBe(200);
      // No waiting: the disable happened before the response.
      expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #65']);
      expect(await res.json()).toMatchObject({
        paused: true,
        sweep: { confirmed: [65], failed: [] },
      });
      // A token cannot resume.
      const resume = await asPrincipal(writeToken).request(
        putUrl(f),
        json('PUT', { paused: false }),
      );
      expect(resume.status).toBe(403);
      const runs = await api.request(`${putUrl(f)}/runs`);
      expect(runs.status).toBe(200);
      expect(((await runs.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });

    it('a failing disable shows in the pause response, which is not a plain 200; the reconcile keeps trying and shouts', async () => {
      const f = await createFixture();
      await enabledPull(f, 66);
      f.repoPull(66).auto = {
        ...f.repoPull(66).auto,
        disableError: { type: 'FORBIDDEN', message: 'Resource not accessible' },
      };
      const res = await asPrincipal(writeToken).request(pauseUrl(f), json('POST'));
      expect(res.status).toBe(207);
      expect(await res.json()).toMatchObject({ paused: true, sweep: { failed: [66] } });
      expect((await runOf(f, 66))?.snapshot).toMatchObject({ appEnabled: true });
      await reconcile();
      const notices = await noticesOf(f);
      expect(notices.some((n) => n.key.startsWith('notice:stuck-enabled:'))).toBe(true);
      expect(
        notices.flatMap((n) => n.actions).find((a) => a.key.startsWith('stuck-enabled:'))?.input,
      ).toMatchObject({ priority: 'urgent' });
      // GitHub recovers: the next pass withdraws it.
      delete f.repoPull(66).auto?.disableError;
      await reconcile();
      expect((await runOf(f, 66))?.snapshot).toMatchObject({ appEnabled: false });
      expect(f.repoPull(66).auto?.autoMergeBy ?? null).toBeNull();
    });

    it('a refused disable (any GraphQL error type) fails the handle: no checks for the head', async () => {
      for (const type of ['UNPROCESSABLE', 'FORBIDDEN', 'RATE_LIMITED']) {
        const f = await createFixture();
        const number = 67;
        f.pull(number, { head: sha(`r-old-${type}`) });
        await deliverAndSettle(
          'pull_request',
          pullRequestEvent(f, 'opened', number, sha(`r-old-${type}`)),
        );
        const fresh = f.pull(number, {
          head: sha(`r-new-${type}`),
          auto: { autoMergeBy: botLogin, disableError: { type, message: 'nope' } },
        });
        await deliverAndSettle(
          'pull_request',
          pullRequestEvent(f, 'synchronize', number, fresh.head),
        );
        expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toEqual([]);
        expect(
          github.automationWrites.some((w) => w === `disablePullRequestAutoMerge #${number}`),
        ).toBe(true);
        expect(
          github.automationWrites.filter((w) =>
            w.startsWith(`enablePullRequestAutoMerge #${number} ${fresh.head}`),
          ),
        ).toEqual([]);
        // GitHub recovers: the reconcile disables, classifies, enables and queues the checks.
        delete f.repoPull(number).auto?.disableError;
        await reconcile();
        expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toHaveLength(1);
      }
    });

    it('a pause racing an in-flight handle: no enable after the pause returned, across instances', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(68);
      const gate = github.gate(/GET .*\/pulls\/68\/commits/);
      // The webhook's service instance starts the handle; it blocks inside a GitHub call.
      await deliver('pull_request', pullRequestEvent(f, 'opened', number, head));
      await gate.entered;
      // Another instance (the routes of another app instance) pauses meanwhile.
      const paused = asPrincipal(writeToken).request(pauseUrl(f), json('POST'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      gate.release();
      const res = await paused;
      expect([200, 207]).toContain(res.status);
      const writes = github.automationWrites.filter((w) => w.includes('#68'));
      await settle();
      await reconcile();
      // The handle woke up after the pause was stored: its enable was dropped.
      expect(
        github.automationWrites.filter((w) => w.startsWith('enablePullRequestAutoMerge #68')),
      ).toEqual([]);
      expect(github.automationWrites.filter((w) => w.includes('#68'))).toEqual(writes);
      expect(f.repoPull(68).auto?.autoMergeBy ?? null).toBeNull();
    });

    it('a pause racing a passkey PUT of another field stays paused', async () => {
      const f = await createFixture();
      for (let round = 0; round < 6; round += 1) {
        await db
          .update(apps)
          .set({ automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, merge: 'on', paused: false } })
          .where(eq(apps.id, f.app.id));
        const [a, b] = await Promise.all([
          asPrincipal(writeToken).request(pauseUrl(f), json('POST')),
          api.request(putUrl(f), json('PUT', { allowedPaths: ['package.json', `x${round}.json`] })),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const body = (await (await api.request(`/api/v1/apps/${f.app.id}`)).json()) as App;
        expect(body.automation.paused).toBe(true);
      }
    });

    it('coalesces the sweeps of a loop of pauses', async () => {
      const f = await createFixture();
      const start = github.calls.length;
      // The first sweep is held at its listing call, so the others arrive while it runs.
      const gate = github.gate(new RegExp(`GET /repos/octo/${f.repo}/pulls$`));
      const pending = Array.from({ length: 6 }, () =>
        asPrincipal(writeToken).request(pauseUrl(f), json('POST')),
      );
      await gate.entered;
      await new Promise((resolve) => setTimeout(resolve, 400));
      gate.release();
      const results = await Promise.all(pending);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const lists = github.calls
        .slice(start)
        .filter((c) => c === `GET /repos/octo/${f.repo}/pulls`);
      expect(lists.length).toBeLessThanOrEqual(2);
    });

    it('a pause with a recorded pull request whose REST field reads null still sends the disable', async () => {
      const f = await createFixture();
      await enabledPull(f, 86);
      f.repoPull(86).auto = { ...f.repoPull(86).auto, restAutoMergeLag: true };
      const before = github.automationWrites.length;
      const res = await asPrincipal(writeToken).request(pauseUrl(f), json('POST'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sweep: { confirmed: [86], failed: [] } });
      expect(github.automationWrites.slice(before)).toContain('disablePullRequestAutoMerge #86');
      expect(f.repoPull(86).auto?.autoMergeBy ?? null).toBeNull();
      expect((await runOf(f, 86))?.snapshot).toMatchObject({ appEnabled: false });
    });

    it('a sibling app on the repository needs a passkey session to create, change or run checks', async () => {
      const f = await createFixture();
      const sibling = {
        name: unique('Sibling'),
        connectionId,
        repository: { owner: 'OCTO', name: f.repo.toUpperCase() },
        nodeId,
      };
      const asToken = asPrincipal(writeToken);
      expect((await asToken.request('/api/v1/apps', json('POST', sibling))).status).toBe(403);
      const created = await api.request('/api/v1/apps', json('POST', sibling));
      expect(created.status).toBe(201);
      const second = (await created.json()) as App;
      const checks = { enabled: true };
      expect(
        (await asToken.request(`/api/v1/apps/${second.id}`, json('PATCH', { checks }))).status,
      ).toBe(403);
      expect(
        (await api.request(`/api/v1/apps/${second.id}`, json('PATCH', { checks }))).status,
      ).toBe(200);
      const run = { ref: 'main' };
      expect(
        (await asToken.request(`/api/v1/apps/${second.id}/checks`, json('POST', run))).status,
      ).toBe(403);
      expect(
        (await api.request(`/api/v1/apps/${second.id}/checks`, json('POST', run))).status,
      ).not.toBe(403);
      const [row] = await db
        .insert(checkRuns)
        .values({
          appId: second.id,
          nodeId,
          name: 'quality',
          command: 'true',
          service: 'dev',
          composeFiles: ['.devcontainer/compose.yaml'],
          timeoutMinutes: 30,
          commitSha: sha('sibling'),
          trigger: 'manual',
          status: 'succeeded',
          reason: 'exit',
        })
        .returning({ id: checkRuns.id });
      const rerun = `/api/v1/checks/${row?.id}/rerun`;
      expect((await asToken.request(rerun, json('POST'))).status).toBe(403);
      expect((await api.request(rerun, json('POST'))).status).not.toBe(403);
      // The automated app itself is not a sibling: its checks run for tokens as before.
      expect(
        (await asToken.request(`/api/v1/apps/${f.app.id}/checks`, json('POST', run))).status,
      ).not.toBe(403);
    });

    it('a pause that commits while an enable is on its way: no App auto-merge remains', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(110);
      const gate = github.gate(/POST \/graphql$/);
      await deliver('pull_request', pullRequestEvent(f, 'opened', number, head));
      await gate.entered;
      const paused = asPrincipal(writeToken).request(pauseUrl(f), json('POST'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      gate.release();
      expect([200, 207]).toContain((await paused).status);
      await settle();
      expect(f.repoPull(110).auto?.autoMergeBy ?? null).toBeNull();
      expect((await runOf(f, 110))?.snapshot).toMatchObject({ paused: true });
    });

    it('twenty events for one pull request are at most two handles, and a pause right after still confirms', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(111);
      const start = github.calls.length;
      const gate = github.gate(new RegExp(`GET /repos/octo/${f.repo}/pulls/111$`));
      await deliver('pull_request', pullRequestEvent(f, 'opened', number, head));
      await gate.entered;
      await Promise.all(
        Array.from({ length: 20 }, () =>
          deliver('pull_request', pullRequestEvent(f, 'synchronize', number, head)),
        ),
      );
      gate.release();
      await settle();
      const reads = github.calls
        .slice(start)
        .filter((c) => c === `GET /repos/octo/${f.repo}/pulls/111`).length;
      // One handle reads the pull request twice (the lists are pinned to the head), the next once.
      expect(reads).toBeLessThanOrEqual(4);
      const started = Date.now();
      const res = await asPrincipal(writeToken).request(pauseUrl(f), json('POST'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sweep: { confirmed: [111], failed: [] } });
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it('a slow GitHub cannot stretch the sweep past its budget; what it could not reach is failed', async () => {
      const f = await createFixture();
      await enabledPull(f, 112);
      github.delays = [{ match: new RegExp(`GET /repos/octo/${f.repo}/pulls(/112)?$`), ms: 3_000 }];
      try {
        const started = Date.now();
        const change = await createAutomationService(deps, { sweepBudgetMs: 1_000 }).pause(
          f.app.id,
          systemActor('test'),
        );
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(change.sweep).toMatchObject({ confirmed: [], failed: [112] });
      } finally {
        github.delays = [];
      }
    });

    it('in on with main red and the disable failing, stuck-enabled is sent', async () => {
      const f = await createFixture();
      await enabledPull(f, 115);
      await insertCheck(f, sha('main'), 'failed');
      f.repoPull(115).auto = {
        ...f.repoPull(115).auto,
        disableError: { type: 'FORBIDDEN', message: 'Resource not accessible' },
      };
      await reconcile();
      expect((await noticesOf(f)).some((n) => n.key.startsWith('notice:stuck-enabled:'))).toBe(
        true,
      );
    });

    it('while the automation is on, tokens and password sessions cannot change checks or the connection', async () => {
      const f = await createFixture();
      const url = `/api/v1/apps/${f.app.id}`;
      const password = testPrincipal('admin', 'password');
      for (const body of [{ checks: { enabled: false } }, { connectionId }]) {
        expect((await asPrincipal(writeToken).request(url, json('PATCH', body))).status).toBe(403);
        expect((await asPrincipal(password).request(url, json('PATCH', body))).status).toBe(403);
      }
      expect((await api.request(url, json('PATCH', { checks: { enabled: true } }))).status).toBe(
        200,
      );
      // With the automation off, nothing changes for tokens.
      await db
        .update(apps)
        .set({ automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, merge: 'off' } })
        .where(eq(apps.id, f.app.id));
      expect(
        (await asPrincipal(writeToken).request(url, json('PATCH', { checks: { enabled: true } })))
          .status,
      ).toBe(200);
    });
  });

  describe('F5: a head always gets its checks', () => {
    const headChecks = async (f: Fixture, head: string) =>
      (await checksOf(f)).filter((c) => c.commitSha === head && c.reason !== 'queue-full');

    it('both deliveries missed: the reconcile classifies the head and queues its checks once', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(80);
      await reconcile();
      await reconcile();
      expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
      expect(await headChecks(f, head)).toHaveLength(1);
    });

    it('hold() fails and the webhook answers 5xx: the reconcile queues the checks', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(81);
      const name = unique('refuse').replaceAll('-', '_');
      await pool.query(
        `create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
      );
      await pool.query(
        `create trigger ${name} before insert on automation_runs for each row when (new.app_id = '${f.app.id}') execute function ${name}()`,
      );
      try {
        const res = await deliverAndSettle(
          'pull_request',
          pullRequestEvent(f, 'opened', number, head),
        );
        expect(res.status).toBeGreaterThanOrEqual(500);
      } finally {
        await pool.query(`drop trigger ${name} on automation_runs`);
        await pool.query(`drop function ${name}()`);
      }
      expect(await headChecks(f, head)).toEqual([]);
      await reconcile();
      expect(await headChecks(f, head)).toHaveLength(1);
    });

    it('held for B while the API shows C and C had no event: the reconcile queues C and clears the entry', async () => {
      const f = await createFixture();
      f.pull(82, { head: sha('f5-a') });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 82, sha('f5-a')));
      const c = f.pull(82, { head: sha('f5-c') });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 82, sha('f5-b')));
      // Fresh: the API may only be behind; nothing is queued for B or C.
      expect(await headChecks(f, sha('f5-b'))).toEqual([]);
      expect(await headChecks(f, c.head)).toEqual([]);
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      await db
        .update(automationRuns)
        .set({
          snapshot:
            sql`jsonb_set(${automationRuns.snapshot}, '{held,at}', ${JSON.stringify(old)}::jsonb)` as never,
        })
        .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.key, 'pr-82')));
      await reconcile();
      expect(await headChecks(f, c.head)).toHaveLength(1);
      expect(await headChecks(f, sha('f5-b'))).toEqual([]);
      expect((await runOf(f, 82))?.snapshot.held ?? null).toBeNull();
    });

    it('a full queue keeps the held checks; with the queue drained the next pass queues them', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(83);
      await db.update(settings).set({ checkMaxQueuedPerApp: 0 }).where(eq(settings.id, 1));
      try {
        await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
        expect(await headChecks(f, head)).toEqual([]);
        expect((await runOf(f, number))?.snapshot.held).toBeTruthy();
      } finally {
        await db.update(settings).set({ checkMaxQueuedPerApp: 30 }).where(eq(settings.id, 1));
      }
      await reconcile();
      expect((await headChecks(f, head)).length).toBeGreaterThan(0);
      expect((await runOf(f, number))?.snapshot.held ?? null).toBeNull();
    });

    it('a classified head without checks for 10 minutes sends one ntfy, and only one', async () => {
      const f = await createFixture();
      const { head, number } = f.pull(84);
      await db.update(settings).set({ checkMaxQueuedPerApp: 0 }).where(eq(settings.id, 1));
      try {
        await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
        const old = new Date(Date.now() - 11 * 60_000).toISOString();
        await db
          .update(automationRuns)
          .set({
            snapshot:
              sql`jsonb_set(${automationRuns.snapshot}, '{firstSeenAt}', ${JSON.stringify(old)}::jsonb)` as never,
          })
          .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.key, 'pr-84')));
        await reconcile();
        await reconcile();
      } finally {
        await db.update(settings).set({ checkMaxQueuedPerApp: 30 }).where(eq(settings.id, 1));
      }
      const notices = (await noticesOf(f)).filter((n) => n.key === `notice:no-checks:${head}`);
      expect(notices).toHaveLength(1);
    });
  });

  describe('N1 and N2: a disable is confirmed by GraphQL, never by its message', () => {
    async function recordedHead(f: Fixture, number: number, head: string) {
      f.pull(number, { head });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
      expect((await runOf(f, number))?.snapshot).toMatchObject({ appEnabled: true });
    }

    it('"not enabled" while the auto-merge is still on: the handle throws, no checks, appEnabled stays', async () => {
      const f = await createFixture();
      await recordedHead(f, 87, sha('n1-old'));
      const fresh = f.pull(87, {
        head: sha('n1-new'),
        auto: {
          autoMergeBy: botLogin,
          disableError: {
            type: 'UNPROCESSABLE',
            message: 'Auto-merge is not enabled for this repository',
          },
        },
      });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 87, fresh.head));
      expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toEqual([]);
      expect((await runOf(f, 87))?.snapshot).toMatchObject({ appEnabled: true });
    });

    it('a refused disable whose re-read shows no request is confirmed', async () => {
      const f = await createFixture();
      await recordedHead(f, 88, sha('n1b-old'));
      // The fake has no request on the new head and refuses the disable; the head is not eligible.
      const fresh = f.pull(88, { head: sha('n1b-new'), auto: { files: [{ filename: 'x.yml' }] } });
      const writes = github.automationWrites.length;
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 88, fresh.head));
      expect(github.automationWrites.slice(writes)).toEqual(['disablePullRequestAutoMerge #88']);
      expect((await runOf(f, 88))?.snapshot).toMatchObject({ appEnabled: false });
      expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toHaveLength(1);
    });

    it('the re-read itself failing fails the handle', async () => {
      const f = await createFixture();
      await recordedHead(f, 89, sha('n1c-old'));
      const fresh = f.pull(89, {
        head: sha('n1c-new'),
        auto: {
          autoMergeBy: botLogin,
          readError: true,
          disableError: { type: 'UNPROCESSABLE', message: 'nope' },
        },
      });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 89, fresh.head));
      expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toEqual([]);
      expect((await runOf(f, 89))?.snapshot).toMatchObject({ appEnabled: true });
    });

    it('same head, REST lags behind the recorded enable, then the policy is tightened: the disable is sent', async () => {
      const f = await createFixture();
      await recordedHead(f, 90, sha('n2-head'));
      f.repoPull(90).auto = { ...f.repoPull(90).auto, restAutoMergeLag: true };
      await db
        .update(apps)
        .set({
          automation: {
            ...DEFAULT_APP_AUTOMATION_SETTINGS,
            merge: 'on',
            allowedPaths: ['package.json'],
          },
        })
        .where(eq(apps.id, f.app.id));
      const writes = github.automationWrites.length;
      await reconcile();
      expect(github.automationWrites.slice(writes)).toContain('disablePullRequestAutoMerge #90');
      expect(f.repoPull(90).auto?.autoMergeBy ?? null).toBeNull();
      expect((await runOf(f, 90))?.snapshot).toMatchObject({ appEnabled: false });
    });
  });

  describe('N3: the locks do not sit on the main pool', () => {
    it('with four handles blocked inside GitHub, an unrelated request still answers at once', async () => {
      const f = await createFixture();
      const gate = github.gateAll(new RegExp(`GET /repos/octo/${f.repo}/pulls/\\d+$`));
      const numbers = [101, 102, 103, 104];
      for (const number of numbers) {
        const { head } = f.pull(number);
        await deliver('pull_request', pullRequestEvent(f, 'opened', number, head));
      }
      await until(async () => gate.held() === numbers.length);
      const started = Date.now();
      expect((await api.request('/api/v1/apps')).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1000);
      const sessions = await pool.query(
        `select state from pg_stat_activity where application_name = 'launchway-locks'`,
      );
      expect(sessions.rows.length).toBeGreaterThan(0);
      expect(sessions.rows.some((r) => String(r.state).startsWith('idle in transaction'))).toBe(
        false,
      );
      gate.release();
      await settle();
    });

    it('a reconcile with one pull request locked by a blocked handle still handles the others', async () => {
      const f = await createFixture();
      const a = f.pull(105);
      const gate = github.gate(new RegExp(`GET /repos/octo/${f.repo}/pulls/105$`));
      await deliver('pull_request', pullRequestEvent(f, 'opened', 105, a.head));
      await gate.entered;
      f.pull(106);
      const done = await Promise.race([
        reconcile().then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('stuck'), 8_000)),
      ]);
      expect(done).toBe('done');
      expect((await runOf(f, 106))?.state).toBe('auto-merge-enabled');
      gate.release();
      await settle();
    });

    it('a handle past its deadline releases the lock, counts a failure and writes nothing more', async () => {
      const f = await createFixture();
      f.pull(107);
      const gate = github.gate(new RegExp(`GET /repos/octo/${f.repo}/pulls/107$`));
      const writes = github.automationWrites.length;
      await createAutomationService(deps, { handleDeadlineMs: 1_000 }).reconcile();
      expect((await runOf(f, 107))?.snapshot).toMatchObject({ failures: 1 });
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(github.automationWrites.slice(writes).filter((w) => w.includes('#107'))).toEqual([]);
      // The lock is free again: the next pass handles the pull request.
      await reconcile();
      expect((await runOf(f, 107))?.state).toBe('auto-merge-enabled');
    });
  });

  describe('round 3: what real GitHub says, and what a handle leaves behind', () => {
    const writeToken: Principal = {
      kind: 'token',
      tokenId: generateId('tok'),
      scopes: ['write'],
      user: admin.user,
    };
    const asPrincipal = (principal: Principal) =>
      createApp(createTestDeps({ db, secrets: deps.secrets, auth: fixedAuth(principal) }));
    const putUrl = (f: Fixture) => `/api/v1/apps/${f.app.id}/automation`;
    const qualityItem = {
      name: 'quality',
      command: 'npm run check',
      service: 'dev',
      timeoutMinutes: 30,
    };

    async function recordedEnable(f: Fixture, number: number) {
      const { head } = f.pull(number);
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
      expect((await runOf(f, number))?.snapshot).toMatchObject({ appEnabled: true });
      return head;
    }

    const setAutomation = (f: Fixture, patch: Partial<AppAutomationSettings>) =>
      db
        .update(apps)
        .set({ automation: { ...DEFAULT_APP_AUTOMATION_SETTINGS, merge: 'on', ...patch } })
        .where(eq(apps.id, f.app.id));

    describe('M1: GraphQL names a bot without [bot]', () => {
      it('same head, recorded enable, REST reads null, then a pause: the disable is sent, then appEnabled clears', async () => {
        const f = await createFixture();
        await recordedEnable(f, 130);
        f.repoPull(130).auto = { ...f.repoPull(130).auto, restAutoMergeLag: true };
        await setAutomation(f, { paused: true });
        const writes = github.automationWrites.length;
        await reconcile();
        expect(github.automationWrites.slice(writes)).toContain('disablePullRequestAutoMerge #130');
        expect(f.repoPull(130).auto?.autoMergeBy ?? null).toBeNull();
        expect((await runOf(f, 130))?.snapshot).toMatchObject({ appEnabled: false });
      });

      it('the same with a tightened policy: the head is ineligible and the disable is sent', async () => {
        const f = await createFixture();
        await recordedEnable(f, 131);
        f.repoPull(131).auto = { ...f.repoPull(131).auto, restAutoMergeLag: true };
        await setAutomation(f, { allowedPaths: ['package.json'] });
        const writes = github.automationWrites.length;
        await reconcile();
        expect(github.automationWrites.slice(writes)).toContain('disablePullRequestAutoMerge #131');
        expect(f.repoPull(131).auto?.autoMergeBy ?? null).toBeNull();
      });

      it('GraphQL answering enabledBy null while an enable is on record counts as the App: disabled', async () => {
        const f = await createFixture();
        await recordedEnable(f, 132);
        f.repoPull(132).auto = {
          ...f.repoPull(132).auto,
          restAutoMergeLag: true,
          enabledByNull: true,
        };
        await setAutomation(f, { paused: true });
        const writes = github.automationWrites.length;
        await reconcile();
        expect(github.automationWrites.slice(writes)).toContain('disablePullRequestAutoMerge #132');
        expect(f.repoPull(132).auto?.autoMergeBy ?? null).toBeNull();
      });

      it("a person's auto-merge (login jens, nothing on record) is left alone in on", async () => {
        const f = await createFixture();
        f.pull(133, { auto: { autoMergeBy: 'jens' } });
        const writes = github.automationWrites.length;
        await reconcile();
        await reconcile();
        expect(github.automationWrites.slice(writes).filter((w) => w.includes('#133'))).toEqual([]);
        expect(f.repoPull(133).auto?.autoMergeBy).toBe('jens');
      });
    });

    describe('M2: a sibling cannot post the contexts the auto-merge waits for', () => {
      async function sibling(f: Fixture): Promise<App> {
        const res = await api.request(
          '/api/v1/apps',
          json('POST', {
            name: unique('Sibling'),
            connectionId,
            repository: { owner: 'OCTO', name: f.repo.toUpperCase() },
            nodeId,
          }),
        );
        expect(res.status).toBe(201);
        return (await res.json()) as App;
      }
      const patchChecks = (app: App, checks: unknown, who = api) =>
        who.request(`/api/v1/apps/${app.id}`, json('PATCH', { checks }));

      it('turning merge or train on answers 409 while a sibling runs a check of the same name', async () => {
        const f = await createFixture({ merge: 'off' });
        const second = await sibling(f);
        expect((await patchChecks(second, { enabled: true, items: [qualityItem] })).status).toBe(
          200,
        );
        for (const body of [{ merge: 'shadow' }, { merge: 'on' }, { train: 'shadow' }]) {
          expect((await api.request(putUrl(f), json('PUT', body))).status).toBe(409);
        }
        // Checks off, or no overlapping name: it goes through.
        expect((await patchChecks(second, { enabled: false })).status).toBe(200);
        expect((await api.request(putUrl(f), json('PUT', { merge: 'shadow' }))).status).toBe(200);
        await api.request(putUrl(f), json('PUT', { merge: 'off' }));
        expect(
          (
            await patchChecks(second, {
              enabled: true,
              items: [{ ...qualityItem, name: 'lint' }],
            })
          ).status,
        ).toBe(200);
        expect((await api.request(putUrl(f), json('PUT', { merge: 'on' }))).status).toBe(200);
      });

      it('while the repository is automated a passkey session cannot enable overlapping checks on a sibling', async () => {
        const f = await createFixture({ merge: 'shadow' });
        const second = await sibling(f);
        expect((await patchChecks(second, { enabled: true, items: [qualityItem] })).status).toBe(
          409,
        );
        expect(
          (await patchChecks(second, { enabled: true, items: [{ ...qualityItem, name: 'lint' }] }))
            .status,
        ).toBe(200);
        expect(
          (await patchChecks(second, { items: [qualityItem, { ...qualityItem, name: 'lint' }] }))
            .status,
        ).toBe(409);
      });

      it('a Dependabot head with a sibling whose checks are off queues no sibling run', async () => {
        const f = await createFixture();
        const second = await sibling(f);
        const { head, number } = f.pull(134);
        await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
        const own = await db.select().from(checkRuns).where(eq(checkRuns.appId, second.id));
        expect(own).toEqual([]);
        expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
      });
    });

    describe('L3: a handle that lost its response or its lock', () => {
      it('an enable GitHub applied whose response is lost still counts as on: a pause sends the disable', async () => {
        const f = await createFixture();
        f.pull(135, { auto: { enableHangsMs: 2_500, restAutoMergeLag: true } });
        await createAutomationService(deps, { handleDeadlineMs: 1_000 }).reconcile();
        expect((await runOf(f, 135))?.snapshot).toMatchObject({ appEnabled: true });
        expect(f.repoPull(135).auto?.autoMergeBy).toBe(botLogin);
        const res = await asPrincipal(writeToken).request(`${putUrl(f)}/pause`, json('POST'));
        expect(res.status).toBe(200);
        expect(f.repoPull(135).auto?.autoMergeBy ?? null).toBeNull();
        expect((await runOf(f, 135))?.snapshot).toMatchObject({ appEnabled: false });
        await new Promise((resolve) => setTimeout(resolve, 1_700));
      });

      it('past the deadline while queueForCommit reads a tree: nothing is queued after the lock is released', async () => {
        const f = await createFixture();
        const { head } = f.pull(136);
        const gate = github.gate(new RegExp(`GET /repos/octo/${f.repo}/git/commits/`));
        await createAutomationService(deps, { handleDeadlineMs: 1_000 }).reconcile();
        gate.release();
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect((await checksOf(f)).filter((c) => c.commitSha === head)).toEqual([]);
        // The lock is free: the next pass queues them.
        await reconcile();
        expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
      });
    });

    describe('L4: the lock connection', () => {
      it('a terminated lock backend fails the handle, the process stays up, and the next pass takes the lock', async () => {
        const f = await createFixture();
        f.pull(137);
        const gate = github.gate(new RegExp(`GET /repos/octo/${f.repo}/pulls/137$`));
        const pass = reconcile();
        await gate.entered;
        await pool.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'launchway-locks'`,
        );
        await pass;
        gate.release();
        await settle();
        expect((await runOf(f, 137))?.snapshot).toMatchObject({ failures: 1 });
        await reconcile();
        expect((await runOf(f, 137))?.state).toBe('auto-merge-enabled');
      });

      it('the lock pool sessions have no idle_session_timeout', async () => {
        const locks = new pg.Pool({
          connectionString: inject('databaseUrl'),
          options: LOCK_POOL_OPTIONS,
        });
        try {
          const res = await locks.query("select current_setting('idle_session_timeout') as v");
          expect(res.rows[0]?.v).toBe('0');
        } finally {
          await locks.end();
        }
      });
    });

    describe('L5: a transient refusal does not drop a safety disable', () => {
      it('the re-run is refused as "Not queued:", a pause commits, and the next round still disables', async () => {
        const f = await createFixture();
        const head = await recordedEnable(f, 138);
        const [queued] = (await checksOf(f)).filter((r) => r.commitSha === head);
        await db
          .update(checkRuns)
          .set({ status: 'errored', reason: 'infrastructure', finishedAt: new Date() })
          .where(eq(checkRuns.id, queued?.id as never));
        // The pause commits right after the refused re-run is recorded.
        await db.execute(
          sql.raw(`create or replace function pause_${f.app.id.replaceAll('-', '_')}() returns trigger as $$
            begin
              if new.app_id = '${f.app.id}' and new.actions::text like '%"refused"%' then
                update apps set automation = jsonb_set(automation, '{paused}', 'true') where id = '${f.app.id}';
              end if;
              return new;
            end $$ language plpgsql`),
        );
        await db.execute(
          sql.raw(`create trigger pause_after_refusal after update on automation_runs
            for each row execute function pause_${f.app.id.replaceAll('-', '_')}()`),
        );
        await db.update(settings).set({ checkMaxQueuedPerApp: 0 }).where(eq(settings.id, 1));
        try {
          await reconcile();
        } finally {
          await db.execute(
            sql.raw('drop trigger if exists pause_after_refusal on automation_runs'),
          );
          await db.execute(
            sql.raw(`drop function if exists pause_${f.app.id.replaceAll('-', '_')}()`),
          );
          await db.update(settings).set({ checkMaxQueuedPerApp: 30 }).where(eq(settings.id, 1));
        }
        expect(f.repoPull(138).auto?.autoMergeBy ?? null).toBeNull();
        expect((await runOf(f, 138))?.snapshot).toMatchObject({ appEnabled: false, paused: true });
      });
    });

    describe('L6: any error answer to a disable is judged by the re-read', () => {
      it.each(['FORBIDDEN', ''])(
        'error type "%s" while no request exists: confirmed, appEnabled cleared',
        async (type) => {
          const f = await createFixture();
          const number = type === '' ? 141 : 140;
          const old = sha(`l6-old-${type}`);
          f.pull(number, { head: old });
          await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, old));
          const fresh = f.pull(number, {
            head: sha(`l6-new-${type}`),
            auto: {
              files: [{ filename: 'x.yml' }],
              disableError: { type, message: 'Auto merge is not enabled' },
            },
          });
          await deliverAndSettle(
            'pull_request',
            pullRequestEvent(f, 'synchronize', number, fresh.head),
          );
          expect((await runOf(f, number))?.snapshot).toMatchObject({ appEnabled: false });
          expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toHaveLength(1);
        },
      );

      it('FORBIDDEN while the App request still exists: the handle throws and no check is queued', async () => {
        const f = await createFixture();
        const old = sha('l6c-old');
        f.pull(142, { head: old });
        await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 142, old));
        const fresh = f.pull(142, {
          head: sha('l6c-new'),
          auto: {
            autoMergeBy: botLogin,
            disableError: { type: 'FORBIDDEN', message: 'Resource not accessible' },
          },
        });
        await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 142, fresh.head));
        expect((await checksOf(f)).filter((c) => c.commitSha === fresh.head)).toEqual([]);
        expect((await runOf(f, 142))?.snapshot).toMatchObject({ appEnabled: true });
      });
    });

    describe('L7: a run that never ran is not a check run', () => {
      it('a head whose only run was superseded gets its checks on the next pass', async () => {
        const f = await createFixture();
        const { head, number } = f.pull(143);
        await db.insert(checkRuns).values({
          appId: f.app.id,
          nodeId,
          name: 'quality',
          command: 'npm run check',
          service: 'dev',
          composeFiles: ['.devcontainer/compose.yaml'],
          timeoutMinutes: 30,
          commitSha: head,
          trigger: 'pull_request',
          status: 'cancelled',
          reason: 'superseded',
        });
        await reconcile();
        expect((await runOf(f, number))?.state).toBe('auto-merge-enabled');
        const live = (await checksOf(f)).filter(
          (c) => c.commitSha === head && c.reason !== 'superseded',
        );
        expect(live).toHaveLength(1);
      });

      it('a head whose run a token cancelled is queued again, and with no run for 10 minutes one notice goes out', async () => {
        const f = await createFixture();
        const { head } = f.pull(144, { head: sha('l7-first-head') });
        await db.insert(checkRuns).values({
          appId: f.app.id,
          nodeId,
          name: 'quality',
          command: 'npm run check',
          service: 'dev',
          composeFiles: ['.devcontainer/compose.yaml'],
          timeoutMinutes: 30,
          commitSha: head,
          trigger: 'pull_request',
          status: 'cancelled',
          reason: 'cancelled',
        });
        await reconcile();
        expect(
          (await checksOf(f)).filter((c) => c.commitSha === head && c.status !== 'cancelled'),
        ).toHaveLength(1);

        // Another head: cancelled, and the queue refuses the new run for ten minutes.
        const second = f.pull(145, { head: sha('l7-second-head') });
        await db.insert(checkRuns).values({
          appId: f.app.id,
          nodeId,
          name: 'quality',
          command: 'npm run check',
          service: 'dev',
          composeFiles: ['.devcontainer/compose.yaml'],
          timeoutMinutes: 30,
          commitSha: second.head,
          trigger: 'pull_request',
          status: 'cancelled',
          reason: 'cancelled',
        });
        await db.update(settings).set({ checkMaxQueuedPerApp: 0 }).where(eq(settings.id, 1));
        try {
          await reconcile();
          const old = new Date(Date.now() - 11 * 60_000).toISOString();
          await db
            .update(automationRuns)
            .set({
              snapshot:
                sql`jsonb_set(${automationRuns.snapshot}, '{firstSeenAt}', ${JSON.stringify(old)}::jsonb)` as never,
            })
            .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.key, 'pr-145')));
          await reconcile();
          await reconcile();
        } finally {
          await db.update(settings).set({ checkMaxQueuedPerApp: 30 }).where(eq(settings.id, 1));
        }
        const notices = (await noticesOf(f)).filter(
          (n) => n.key === `notice:no-checks:${second.head}`,
        );
        expect(notices).toHaveLength(1);
      });
    });

    describe('L8: deleting an app or moving its checks node while it is automated', () => {
      it('a write-scope token gets 403 on DELETE and on a nodeId change', async () => {
        const f = await createFixture();
        const asToken = asPrincipal(writeToken);
        expect(
          (await asToken.request(`/api/v1/apps/${f.app.id}?force=true`, json('DELETE'))).status,
        ).toBe(403);
        expect(
          (await asToken.request(`/api/v1/apps/${f.app.id}`, json('PATCH', { nodeId }))).status,
        ).toBe(403);
      });

      it('a passkey session deletes the app, and its auto-merge is disabled before the rows go', async () => {
        const f = await createFixture();
        await recordedEnable(f, 146);
        // An offline node: the delete does not wait for an agent (force).
        const [gone] = await db
          .insert(nodes)
          .values({ name: unique('node'), status: 'offline', lanIp: '192.168.1.42' })
          .returning({ id: nodes.id });
        await db
          .update(apps)
          .set({ nodeId: gone?.id as NodeId })
          .where(eq(apps.id, f.app.id));
        const writes = github.automationWrites.length;
        const res = await api.request(`/api/v1/apps/${f.app.id}?force=true`, json('DELETE'));
        expect(res.status).toBe(204);
        expect(github.automationWrites.slice(writes)).toContain('disablePullRequestAutoMerge #146');
        expect(f.repoPull(146).auto?.autoMergeBy ?? null).toBeNull();
      });
    });
  });

  describe('notices and shadow', () => {
    const handleFailures = async (f: Fixture) =>
      (await noticesOf(f)).filter((n) => n.key.startsWith('notice:handle-failed:'));

    async function failThrice(f: Fixture, number: number, head: string) {
      github.failRepoRequests = 1_000;
      try {
        for (let n = 0; n < 3; n += 1) {
          await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', number, head));
        }
      } finally {
        github.failRepoRequests = 0;
      }
    }

    it('two failure streaks on two heads of one pull request send two notices', async () => {
      const f = await createFixture();
      const first = f.pull(120, { head: sha('streak-1') });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', 120, first.head));
      await failThrice(f, 120, first.head);
      expect(await handleFailures(f)).toHaveLength(1);
      // A success ends the streak; the next head fails again.
      const second = f.pull(120, { head: sha('streak-2') });
      await deliverAndSettle('pull_request', pullRequestEvent(f, 'synchronize', 120, second.head));
      await failThrice(f, 120, second.head);
      expect(await handleFailures(f)).toHaveLength(2);
    });

    it('two GitHub outages an hour apart send two main-unknown notices', async () => {
      const f = await createFixture();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        for (const at of ['2030-01-01T10:05:00Z', '2030-01-01T11:05:00Z']) {
          vi.setSystemTime(new Date(at));
          github.failRepoRequests = 1_000;
          await reconcile();
          github.failRepoRequests = 0;
        }
      } finally {
        vi.useRealTimers();
        github.failRepoRequests = 0;
      }
      const keys = (await noticesOf(f)).map((n) => n.key);
      expect(keys).toContain('notice:main-unknown:unreachable:2030-01-01T10');
      expect(keys).toContain('notice:main-unknown:unreachable:2030-01-01T11');
    });

    it('only a connection that cannot write raises "cannot reach GitHub"; the notice has its own kind', async () => {
      const outage = await createFixture();
      outage.pull(121);
      github.failRepoRequests = 1_000;
      await deliverAndSettle(
        'pull_request',
        pullRequestEvent(outage, 'opened', 121, outage.repoPull(121).headSha),
      );
      github.failRepoRequests = 0;
      expect(
        (await noticesOf(outage)).filter((n) => n.key.startsWith('notice:no-github:')),
      ).toEqual([]);

      const f = await createFixture();
      f.pull(122);
      const patId = generateId('gh');
      await db.insert(githubConnections).values({
        id: patId,
        kind: 'pat',
        name: unique('PAT'),
        tokenEncrypted: 'not-used',
      });
      await db.update(apps).set({ connectionId: patId }).where(eq(apps.id, f.app.id));
      await reconcile();
      await reconcile();
      const sent = (await noticesOf(f)).filter((n) => n.key.startsWith('notice:no-github:'));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.kind).toBe('notice');
      const trains = await db
        .select()
        .from(automationRuns)
        .where(and(eq(automationRuns.appId, f.app.id), eq(automationRuns.kind, 'train')));
      expect(trains).toEqual([]);
    });

    it('in shadow, a failing classification does not withhold the checks the webhook queues', async () => {
      const f = await createFixture({ merge: 'shadow' });
      const { head, number } = f.pull(123);
      github.failRepoRequests = 1_000;
      try {
        await deliverAndSettle('pull_request', pullRequestEvent(f, 'opened', number, head));
      } finally {
        github.failRepoRequests = 0;
      }
      expect((await checksOf(f)).filter((c) => c.commitSha === head)).toHaveLength(1);
    });
  });
});
