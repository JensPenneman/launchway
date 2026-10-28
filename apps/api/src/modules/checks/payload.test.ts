import { type AppId, CheckRunPayload, generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { checksSettingsOf, runSnapshot } from './model.js';
import {
  buildCheckRunPayload,
  type CheckRunPayloadInput,
  InvalidCheckRunPayloadError,
} from './payload.js';

const runId = generateId('chk');
const appId = generateId('app') as AppId;
const sha = '3f786850e387550fdab836ed7e6dc881de23001b';

function input(overrides: Partial<CheckRunPayloadInput['run']> = {}): CheckRunPayloadInput {
  return {
    run: {
      id: runId,
      name: 'quality',
      command: 'npm ci && npm run check',
      service: 'dev',
      composeFiles: ['.devcontainer/compose.yaml'],
      timeoutMinutes: 30,
      commitSha: sha,
      ref: 'main',
      ...overrides,
    },
    app: { id: appId, slug: 'trail' },
    clone: {
      cloneUrl: 'https://github.com/octo/trail.git',
      authorization: 'basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==',
    },
    limits: { checkMemoryMb: 4096, checkCpus: 1.5, checkPidsLimit: 2048 },
  };
}

describe('buildCheckRunPayload', () => {
  it('builds the check.run request from the run snapshot and the platform limits', () => {
    const payload = buildCheckRunPayload(input());
    expect(payload).toEqual({
      runId,
      app: { id: appId, slug: 'trail' },
      source: {
        cloneUrl: 'https://github.com/octo/trail.git',
        ref: 'main',
        sha,
        authorization: 'basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==',
      },
      composeFiles: ['.devcontainer/compose.yaml'],
      check: {
        name: 'quality',
        service: 'dev',
        command: 'npm ci && npm run check',
        timeoutMs: 30 * 60_000,
      },
      limits: { memoryBytes: 4096 * 1024 * 1024, cpus: 1.5, pidsLimit: 2048 },
    });
    expect(CheckRunPayload.parse(payload)).toEqual(payload);
  });

  it('names the commit as the ref when a run has none', () => {
    expect(buildCheckRunPayload(input({ ref: null })).source.ref).toBe(sha);
  });

  it('refuses payloads the agent would refuse, without repeating values', () => {
    const secret = `basic ${'s'.repeat(5000)}`;
    const broken = {
      ...input({ command: '' }),
      clone: { ...input().clone, authorization: secret },
    };
    let error: unknown;
    try {
      buildCheckRunPayload(broken);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidCheckRunPayloadError);
    const { paths, message } = error as InvalidCheckRunPayloadError;
    expect(paths).toEqual(expect.arrayContaining(['source.authorization', 'check.command']));
    expect(message).not.toContain('sss');
  });
});

describe('run snapshot', () => {
  const settings = checksSettingsOf({
    checks: {
      enabled: true,
      composeFiles: ['compose.yaml', 'compose.dev.yaml'],
      branches: null,
      skipBots: false,
      items: [],
      schedule: null,
    },
  });

  it('takes the Compose files of the checks, or the check own file', () => {
    const item = { name: 'lint', command: 'npm run lint', service: 'dev', timeoutMinutes: 5 };
    expect(runSnapshot(item, settings)).toEqual({
      name: 'lint',
      command: 'npm run lint',
      service: 'dev',
      composeFiles: ['compose.yaml', 'compose.dev.yaml'],
      timeoutMinutes: 5,
    });
    expect(
      runSnapshot({ ...item, composeFile: 'compose.e2e.yaml' }, settings).composeFiles,
    ).toEqual(['compose.e2e.yaml']);
  });

  it('fills settings stored before a key existed with its default', () => {
    const stored = { enabled: true, items: [] } as unknown as Parameters<
      typeof checksSettingsOf
    >[0]['checks'];
    expect(checksSettingsOf({ checks: stored })).toEqual({
      enabled: true,
      composeFiles: ['.devcontainer/compose.yaml'],
      branches: null,
      skipBots: false,
      items: [],
      schedule: null,
    });
  });
});
