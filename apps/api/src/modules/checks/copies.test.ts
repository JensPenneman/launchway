import { describe, expect, it } from 'vitest';
import { COPYABLE_TRIGGERS, copyOf, isCopySource, sameTreeMessage } from './copies.js';
import type { CheckRunRow } from './model.js';

const STARTED = new Date('2026-10-28T09:00:00Z');

function run(fields: Partial<CheckRunRow> = {}): CheckRunRow {
  return {
    id: 'chk_01' as CheckRunRow['id'],
    appId: 'app_01' as CheckRunRow['appId'],
    nodeId: 'node_01' as CheckRunRow['nodeId'],
    name: 'quality',
    command: 'npm test',
    service: 'dev',
    composeFiles: ['.devcontainer/compose.yaml'],
    timeoutMinutes: 30,
    commitSha: '3f786850e387550fdab836ed7e6dc881de23001b',
    ref: 'feature/x',
    prNumber: 12,
    trigger: 'pull_request',
    status: 'succeeded',
    reason: 'exit',
    exitCode: 0,
    statusMessage: null,
    githubState: 'success',
    triggeredById: null,
    treeSha: 'b'.repeat(40),
    copiedFromId: null,
    alsoRef: null,
    startedAt: STARTED,
    finishedAt: new Date(STARTED.getTime() + 258_000),
    createdAt: new Date(STARTED.getTime() - 60_000),
    updatedAt: STARTED,
    ...fields,
  };
}

describe('same-tree copies', () => {
  it('describe the verdict they reuse', () => {
    expect(sameTreeMessage(run())).toBe('Same tree as 3f78685, passed in 4m 18s');
    expect(sameTreeMessage(run({ status: 'failed', exitCode: 1 }))).toBe(
      'Same tree as 3f78685, failed: exit code 1 after 4m 18s',
    );
    expect(sameTreeMessage(run({ status: 'failed', exitCode: null }))).toBe(
      'Same tree as 3f78685, failed after 4m 18s',
    );
  });

  it('reuse only runs whose command ran and exited, with a known tree', () => {
    expect(isCopySource(run())).toBe(true);
    expect(isCopySource(run({ status: 'failed', exitCode: 2 }))).toBe(true);
    // A timeout may be the node's load, an error or a cancellation is no verdict at all.
    expect(isCopySource(run({ status: 'failed', reason: 'timeout' }))).toBe(false);
    expect(isCopySource(run({ status: 'errored', reason: 'build' }))).toBe(false);
    expect(isCopySource(run({ status: 'cancelled', reason: 'cancelled' }))).toBe(false);
    // A copy is never a source: its own source is.
    expect(isCopySource(run({ reason: 'same-tree' }))).toBe(false);
    expect(isCopySource(run({ treeSha: null }))).toBe(false);
  });

  it('end as the verdict of their source, linked to it', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    expect(copyOf(run({ id: 'chk_source' as CheckRunRow['id'] }), now)).toEqual({
      status: 'succeeded',
      reason: 'same-tree',
      exitCode: 0,
      statusMessage: 'Same tree as 3f78685, passed in 4m 18s',
      copiedFromId: 'chk_source',
      finishedAt: now,
    });
    // Manual runs, re-runs and scheduled runs always run.
    expect(COPYABLE_TRIGGERS).toEqual(['push', 'pull_request']);
  });
});
