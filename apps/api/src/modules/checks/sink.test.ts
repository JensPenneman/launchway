import { describe, expect, it } from 'vitest';
import { checkResultOutcome } from './sink.js';

const run = { statusMessage: null, timeoutMinutes: 30 };

describe('checkResultOutcome', () => {
  it('passes a run that exited 0', () => {
    expect(checkResultOutcome(run, { reason: 'exit', exitCode: 0 })).toEqual({
      status: 'succeeded',
      reason: 'exit',
      exitCode: 0,
      statusMessage: null,
    });
  });

  it('fails a non-zero exit and a timeout: both are verdicts on the code', () => {
    expect(
      checkResultOutcome(run, {
        reason: 'exit',
        exitCode: 137,
        message: 'Exited with code 137 (out of memory)',
      }),
    ).toEqual({
      status: 'failed',
      reason: 'exit',
      exitCode: 137,
      statusMessage: 'Exited with code 137 (out of memory)',
    });
    expect(checkResultOutcome(run, { reason: 'exit', exitCode: 2 }).statusMessage).toBe(
      'Exited with code 2',
    );
    expect(checkResultOutcome(run, { reason: 'exit', exitCode: null })).toMatchObject({
      status: 'failed',
      statusMessage: 'Exited without an exit code',
    });
    expect(checkResultOutcome(run, { reason: 'timeout', exitCode: null })).toEqual({
      status: 'failed',
      reason: 'timeout',
      exitCode: null,
      statusMessage: 'Timed out after 30 minutes',
    });
  });

  it('errors what is no verdict: policy, build, infrastructure, interruption', () => {
    for (const reason of ['policy', 'build', 'infrastructure', 'interrupted'] as const) {
      const outcome = checkResultOutcome(run, {
        reason,
        exitCode: null,
        message: `${reason} went wrong\n--- last log lines ---\nboom`,
      });
      expect(outcome).toEqual({
        status: 'errored',
        reason,
        exitCode: null,
        statusMessage: `${reason} went wrong\n--- last log lines ---\nboom`,
      });
      expect(checkResultOutcome(run, { reason, exitCode: null }).statusMessage).toEqual(
        expect.any(String),
      );
    }
    expect(checkResultOutcome(run, { reason: 'interrupted', exitCode: null }).statusMessage).toBe(
      'Interrupted: the agent shut down',
    );
  });

  it('cancels, keeping the message of a deliberate cancel', () => {
    expect(checkResultOutcome(run, { reason: 'cancelled', exitCode: null })).toEqual({
      status: 'cancelled',
      reason: 'cancelled',
      exitCode: null,
      statusMessage: 'Cancelled',
    });
    const kept = (statusMessage: string) =>
      checkResultOutcome({ ...run, statusMessage }, { reason: 'cancelled', exitCode: null })
        .statusMessage;
    expect(kept('Cancelled: the app is being deleted')).toBe('Cancelled: the app is being deleted');
    expect(kept('Superseded by 0123456789ab')).toBe('Superseded by 0123456789ab');
    expect(kept('Cancellation requested')).toBe('Cancelled');
  });
});
