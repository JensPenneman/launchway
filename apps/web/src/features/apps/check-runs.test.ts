import { describe, expect, it } from 'vitest';
import {
  checkLogEmptyText,
  checkRunOutcome,
  checkRunQueueLabel,
  checkRunStartedLabel,
} from './check-runs';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

describe('checkRunOutcome', () => {
  it('describes exits with their code and time-outs with the limit', () => {
    expect(checkRunOutcome({ reason: 'exit', exitCode: 0, timeoutMinutes: 30 })).toBe(
      'The command exited with code 0',
    );
    expect(checkRunOutcome({ reason: 'exit', exitCode: 2, timeoutMinutes: 30 })).toBe(
      'The command exited with code 2',
    );
    expect(checkRunOutcome({ reason: 'timeout', exitCode: null, timeoutMinutes: 30 })).toBe(
      'Timed out after 30 minutes',
    );
    expect(checkRunOutcome({ reason: 'timeout', exitCode: null, timeoutMinutes: 1 })).toBe(
      'Timed out after 1 minute',
    );
  });

  it('explains runs without a verdict and is null while a run is active', () => {
    expect(checkRunOutcome({ reason: 'superseded', exitCode: null, timeoutMinutes: 30 })).toBe(
      'A newer commit of the branch arrived while it waited',
    );
    expect(checkRunOutcome({ reason: null, exitCode: null, timeoutMinutes: 30 })).toBeNull();
    expect(checkRunOutcome({ reason: 'closed', exitCode: null, timeoutMinutes: 30 })).toBe(
      'Its pull request was closed or merged before it ran',
    );
    expect(checkRunOutcome({ reason: 'same-tree', exitCode: 0, timeoutMinutes: 30 })).toMatch(
      /^Not run: the same check had run for a commit with the same files/,
    );
  });
});

describe('checkRunQueueLabel', () => {
  it("tells a queued run's place on its node", () => {
    expect(checkRunQueueLabel({ status: 'queued', queuedBehind: 0 })).toBe('next on its node');
    expect(checkRunQueueLabel({ status: 'queued', queuedBehind: 1 })).toBe(
      'starts after 1 run ends',
    );
    expect(checkRunQueueLabel({ status: 'queued', queuedBehind: 5 })).toBe(
      'starts after 5 runs end',
    );
    expect(checkRunQueueLabel({ status: 'running', queuedBehind: null })).toBeNull();
  });
});

describe('checkRunStartedLabel', () => {
  const createdAt = '2026-10-27T11:50:00.000Z';

  it('tells when a run started, or since when it waits', () => {
    expect(
      checkRunStartedLabel(
        { status: 'running', createdAt, startedAt: '2026-10-27T11:57:00.000Z' },
        NOW,
      ),
    ).toBe('3 minutes ago');
    expect(checkRunStartedLabel({ status: 'queued', createdAt, startedAt: null }, NOW)).toBe(
      'queued 10 minutes ago',
    );
  });

  it('marks runs that ended before they started', () => {
    expect(checkRunStartedLabel({ status: 'errored', createdAt, startedAt: null }, NOW)).toBe(
      'not started',
    );
  });
});

describe('checkLogEmptyText', () => {
  it('names the log retention once a run has finished', () => {
    expect(checkLogEmptyText('succeeded')).toBe('No output. Check logs are kept for 30 days.');
    expect(checkLogEmptyText('queued')).toMatch(/^Queued/);
  });
});
