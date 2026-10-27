import { describe, expect, it } from 'vitest';
import {
  CheckRunPayload,
  HeartbeatPayload,
  parseAgentToServerMessage,
  parseServerToAgentMessage,
} from './agent/messages.js';
import {
  AppChecksSettings,
  CheckItemInput,
  CheckName,
  DEFAULT_APP_CHECKS_SETTINGS,
  UpdateAppChecksSettings,
  UpdateAppInput,
} from './apps.js';
import {
  CHECK_RESULT_REASONS,
  CHECK_RUN_REASONS,
  CHECK_RUN_STATUSES,
  CheckCpus,
  CheckRun,
  CreateCheckRunsInput,
  checkImageName,
  checkProjectName,
  checkStatusContext,
  githubStateOfCheck,
  isActiveCheckRunStatus,
} from './checks.js';
import { generateId } from './ids.js';

describe('check settings', () => {
  it('accepts names that fit a status context and refuses others', () => {
    for (const name of ['quality', 'e2e', 'test-1', 'a', 'x'.repeat(39)]) {
      expect(CheckName.safeParse(name).success, name).toBe(true);
    }
    for (const name of ['', 'Quality', '-lint', 'a_b', 'a/b', 'x'.repeat(40), 'lint check']) {
      expect(CheckName.safeParse(name).success, name).toBe(false);
    }
  });

  it('fills in the service and the timeout of a new check', () => {
    expect(CheckItemInput.parse({ name: 'quality', command: '  npm run check  ' })).toEqual({
      name: 'quality',
      command: 'npm run check',
      service: 'dev',
      timeoutMinutes: 30,
    });
  });

  it('bounds the command and the timeout', () => {
    const base = { name: 'quality', command: 'npm test' };
    expect(CheckItemInput.safeParse({ ...base, command: ' ' }).success).toBe(false);
    expect(CheckItemInput.safeParse({ ...base, command: 'x'.repeat(4097) }).success).toBe(false);
    expect(CheckItemInput.safeParse({ ...base, command: 'a\0b' }).success).toBe(false);
    expect(CheckItemInput.safeParse({ ...base, timeoutMinutes: 0 }).success).toBe(false);
    expect(CheckItemInput.safeParse({ ...base, timeoutMinutes: 121 }).success).toBe(false);
    expect(CheckItemInput.safeParse({ ...base, timeoutMinutes: 120 }).success).toBe(true);
    expect(CheckItemInput.safeParse({ ...base, composeFile: '../compose.yaml' }).success).toBe(
      false,
    );
    expect(CheckItemInput.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it('allows at most ten checks with unique names', () => {
    const item = (name: string) => ({ name, command: 'true' });
    const ten = Array.from({ length: 10 }, (_, index) => item(`c${index}`));
    expect(UpdateAppChecksSettings.safeParse({ items: ten }).success).toBe(true);
    expect(UpdateAppChecksSettings.safeParse({ items: [...ten, item('c10')] }).success).toBe(false);
    expect(UpdateAppChecksSettings.safeParse({ items: [item('a'), item('a')] }).success).toBe(
      false,
    );
    expect(
      AppChecksSettings.safeParse({
        ...DEFAULT_APP_CHECKS_SETTINGS,
        items: [
          { name: 'a', command: 'x', service: 'dev', timeoutMinutes: 5 },
          { name: 'a', command: 'y', service: 'dev', timeoutMinutes: 5 },
        ],
      }).success,
    ).toBe(false);
  });

  it('takes exact, unique branch names or null', () => {
    expect(UpdateAppChecksSettings.parse({ branches: ['main', 'release/1.x'] }).branches).toEqual([
      'main',
      'release/1.x',
    ]);
    expect(UpdateAppChecksSettings.parse({ branches: null }).branches).toBeNull();
    expect(UpdateAppChecksSettings.safeParse({ branches: [] }).success).toBe(false);
    expect(UpdateAppChecksSettings.safeParse({ branches: ['main', 'main'] }).success).toBe(false);
    expect(UpdateAppChecksSettings.safeParse({ branches: ['-x'] }).success).toBe(false);
  });

  it('defaults to the dev container and off', () => {
    expect(AppChecksSettings.parse(DEFAULT_APP_CHECKS_SETTINGS)).toEqual({
      enabled: false,
      composeFiles: ['.devcontainer/compose.yaml'],
      branches: null,
      skipBots: false,
      items: [],
    });
  });

  it('is part of the app update', () => {
    expect(UpdateAppInput.safeParse({ checks: { enabled: true } }).success).toBe(true);
    expect(UpdateAppInput.safeParse({ checks: { unknown: true } }).success).toBe(false);
  });
});

describe('check runs', () => {
  it('maps every status to a GitHub commit status state', () => {
    expect(CHECK_RUN_STATUSES.map((status) => [status, githubStateOfCheck(status)])).toEqual([
      ['queued', 'pending'],
      ['running', 'pending'],
      ['succeeded', 'success'],
      ['failed', 'failure'],
      ['errored', 'error'],
      ['cancelled', 'error'],
    ]);
    expect(CHECK_RUN_STATUSES.filter(isActiveCheckRunStatus)).toEqual(['queued', 'running']);
  });

  it('only lets agents report reasons that are run reasons', () => {
    for (const reason of CHECK_RESULT_REASONS) expect(CHECK_RUN_REASONS).toContain(reason);
  });

  it('names projects, images and status contexts', () => {
    const runId = generateId('chk');
    const project = checkProjectName('trail', runId);
    expect(project).toBe(`launchway-check_trail_${runId.slice(4)}`);
    expect(project).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(checkImageName('trail', 'dev')).toBe('launchway-check/trail-dev');
    expect(checkStatusContext('e2e')).toBe('launchway/e2e');
  });

  it('accepts manual runs of a ref with an optional subset of checks', () => {
    expect(CreateCheckRunsInput.parse({ ref: 'main' })).toEqual({ ref: 'main' });
    expect(CreateCheckRunsInput.safeParse({ ref: 'main', names: [] }).success).toBe(false);
    expect(CreateCheckRunsInput.safeParse({ ref: 'main', names: ['a', 'a'] }).success).toBe(false);
    expect(CreateCheckRunsInput.safeParse({ ref: '--upload-pack=x' }).success).toBe(false);
  });

  it('takes CPU limits in quarters', () => {
    expect(CheckCpus.safeParse(1.5).success).toBe(true);
    expect(CheckCpus.safeParse(0.25).success).toBe(true);
    expect(CheckCpus.safeParse(0.3).success).toBe(false);
    expect(CheckCpus.safeParse(0).success).toBe(false);
  });

  it('describes a run', () => {
    const now = new Date().toISOString();
    expect(
      CheckRun.safeParse({
        id: generateId('chk'),
        appId: generateId('app'),
        nodeId: generateId('node'),
        name: 'quality',
        command: 'npm run check',
        service: 'dev',
        composeFiles: ['.devcontainer/compose.yaml'],
        timeoutMinutes: 30,
        commitSha: 'a'.repeat(40),
        ref: 'main',
        prNumber: null,
        trigger: 'push',
        status: 'failed',
        reason: 'exit',
        exitCode: 3,
        statusMessage: 'Exited with code 3',
        githubState: 'failure',
        triggeredBy: null,
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
  });
});

describe('check protocol', () => {
  const runId = generateId('chk');
  const run = {
    id: 'm-1',
    type: 'check.run',
    payload: {
      runId,
      app: { id: generateId('app'), slug: 'trail' },
      source: {
        cloneUrl: 'https://github.com/jenspenneman/trail.git',
        ref: 'main',
        sha: 'b'.repeat(40),
        authorization: 'basic dG9rZW4=',
      },
      composeFiles: ['.devcontainer/compose.yaml'],
      check: { name: 'quality', service: 'dev', command: 'npm run check', timeoutMs: 1_800_000 },
      limits: { memoryBytes: 4 * 1024 ** 3, cpus: 2, pidsLimit: 4096 },
    },
  };

  it('parses check.run and check.cancel', () => {
    expect(parseServerToAgentMessage(JSON.stringify(run)).ok).toBe(true);
    expect(
      parseServerToAgentMessage(
        JSON.stringify({ id: 'm-2', type: 'check.cancel', payload: { runId } }),
      ).ok,
    ).toBe(true);
  });

  it('refuses plain-http clone URLs and timeouts out of range', () => {
    const payload = run.payload;
    expect(
      CheckRunPayload.safeParse({
        ...payload,
        source: { ...payload.source, cloneUrl: 'http://github.com/x/y.git' },
      }).success,
    ).toBe(false);
    expect(
      CheckRunPayload.safeParse({ ...payload, check: { ...payload.check, timeoutMs: 1000 } })
        .success,
    ).toBe(false);
  });

  it('parses check.log and check.result', () => {
    const log = {
      id: 'm-1',
      type: 'check.log',
      payload: {
        runId,
        lines: [{ seq: 0, timestamp: new Date().toISOString(), stream: 'stdout', line: 'ok' }],
      },
    };
    expect(parseAgentToServerMessage(JSON.stringify(log)).ok).toBe(true);
    const result = {
      id: 'm-1',
      type: 'check.result',
      payload: { runId, reason: 'exit', exitCode: 3 },
    };
    expect(parseAgentToServerMessage(JSON.stringify(result)).ok).toBe(true);
    const unknownReason = { ...result, payload: { ...result.payload, reason: 'superseded' } };
    expect(parseAgentToServerMessage(JSON.stringify(unknownReason)).ok).toBe(false);
  });

  it('keeps heartbeats of agents without checks valid', () => {
    const sentAt = new Date().toISOString();
    expect(HeartbeatPayload.safeParse({ sentAt, activeDeploymentIds: [] }).success).toBe(true);
    expect(
      HeartbeatPayload.parse({ sentAt, activeDeploymentIds: [], activeCheckRunIds: [runId] })
        .activeCheckRunIds,
    ).toEqual([runId]);
  });
});
