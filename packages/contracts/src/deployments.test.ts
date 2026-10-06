import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRANSITIONS,
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  InvalidDeploymentTransitionError,
  isInProgressStatus,
  isTerminalStatus,
  TERMINAL_DEPLOYMENT_STATUSES,
} from './deployments.js';

describe('deployment state machine', () => {
  it('follows the happy path queued -> running -> superseded', () => {
    const path = ['queued', 'cloning', 'building', 'starting', 'running', 'superseded'] as const;
    for (let i = 1; i < path.length; i++) {
      expect(
        canTransition(path[i - 1] as (typeof path)[number], path[i] as (typeof path)[number]),
      ).toBe(true);
    }
  });

  it.each(IN_PROGRESS_DEPLOYMENT_STATUSES)(
    'lets in-progress state %s fail or be cancelled',
    (status) => {
      expect(canTransition(status, 'failed')).toBe(true);
      expect(canTransition(status, 'cancelled')).toBe(true);
      expect(isInProgressStatus(status)).toBe(true);
    },
  );

  it('leaves running only through superseded or stopped', () => {
    expect(DEPLOYMENT_TRANSITIONS.running).toEqual(['superseded', 'stopped']);
    expect(canTransition('running', 'cancelled')).toBe(false);
    expect(canTransition('running', 'failed')).toBe(false);
  });

  it.each(TERMINAL_DEPLOYMENT_STATUSES)('has no exits from terminal state %s', (status) => {
    expect(isTerminalStatus(status)).toBe(true);
    for (const to of DEPLOYMENT_STATUSES) expect(canTransition(status, to)).toBe(false);
  });

  it('never skips stages or moves backwards', () => {
    expect(canTransition('queued', 'building')).toBe(false);
    expect(canTransition('building', 'cloning')).toBe(false);
    expect(canTransition('starting', 'queued')).toBe(false);
  });

  it('defines transitions for every status, all pointing at known statuses', () => {
    expect(Object.keys(DEPLOYMENT_TRANSITIONS).sort()).toEqual([...DEPLOYMENT_STATUSES].sort());
    for (const targets of Object.values(DEPLOYMENT_TRANSITIONS)) {
      for (const target of targets) expect(DEPLOYMENT_STATUSES).toContain(target);
    }
  });

  it('assertTransition throws a typed error', () => {
    expect(() => assertTransition('queued', 'cloning')).not.toThrow();
    expect(() => assertTransition('failed', 'running')).toThrow(InvalidDeploymentTransitionError);
  });
});
