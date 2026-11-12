import { describe, expect, it } from 'vitest';
import type { ActionOutcome, AutomationAction } from './actions.js';
import {
  CONFLICT_NOTICE_AFTER_MS,
  type DecideSnapshot,
  decide,
  MAX_REFUSED_RERUNS,
  MAX_TRANSIENT_RETRIES,
} from './decide.js';

const HEAD = 'a'.repeat(40);
const NOW = '2026-11-10T10:00:00.000Z';

function snapshot(over: Partial<DecideSnapshot> = {}): DecideSnapshot {
  return {
    now: NOW,
    mode: 'on',
    paused: false,
    main: 'green',
    requiredChecks: ['quality'],
    pull: {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      headSha: HEAD,
      open: true,
      merged: false,
      autoMerge: 'none',
      conflictSince: null,
    },
    verdict: { verdict: 'eligible' },
    recorded: { state: null, reason: null, stateSeq: 0 },
    checks: [],
    done: {},
    ...over,
  };
}

const PASSED = [{ id: 'chk_q', name: 'quality', status: 'succeeded' as const }];
const types = (actions: AutomationAction[]) => actions.map((a) => a.type);
const withPull = (over: Partial<DecideSnapshot['pull']>) => ({ ...snapshot().pull, ...over });

describe('decide: the merge policy', () => {
  it('enables auto-merge pinned to the head of an eligible pull request', () => {
    const actions = decide(snapshot());
    expect(actions[0]).toEqual({
      type: 'github.enableAutoMerge',
      key: `enable:${HEAD}:0`,
      input: { pullNumber: 7, expectedHeadOid: HEAD },
    });
    expect(types(actions)).toEqual(['github.enableAutoMerge']);
  });

  it('does nothing when the mode is off, except withdrawing an App auto-merge', () => {
    expect(decide(snapshot({ mode: 'off' }))).toEqual([]);
    expect(types(decide(snapshot({ mode: 'off', pull: withPull({ autoMerge: 'app' }) })))).toEqual([
      'github.disableAutoMerge',
    ]);
  });

  it('enables, merges and re-runs nothing in shadow mode, but withdraws an App auto-merge', () => {
    const actions = decide(
      snapshot({
        mode: 'shadow',
        checks: [{ id: 'chk_1', name: 'quality', status: 'errored' }],
        pull: withPull({ autoMerge: 'app' }),
      }),
    );
    expect(types(actions)).toEqual(['github.disableAutoMerge', 'recordState']);
    expect(actions[1]?.input).toMatchObject({ state: 'shadow' });
  });

  it('disables an auto-merge the App enabled while the head is not classified yet', () => {
    const actions = decide(snapshot({ verdict: null, pull: withPull({ autoMerge: 'app' }) }));
    expect(actions).toEqual([
      {
        type: 'github.disableAutoMerge',
        key: `disable:${HEAD}:0`,
        input: { pullNumber: 7 },
      },
    ]);
    expect(decide(snapshot({ verdict: null }))).toEqual([]);
  });

  it('never touches an auto-merge somebody else enabled', () => {
    const actions = decide(snapshot({ verdict: null, pull: withPull({ autoMerge: 'other' }) }));
    expect(actions).toEqual([]);
    expect(types(decide(snapshot({ pull: withPull({ autoMerge: 'other' }) })))).toEqual([
      'recordState',
    ]);
  });

  it.each([
    ['ineligible', { verdict: 'ineligible', reason: 'x' } as const],
    ['hold', { verdict: 'hold', reason: 'postgres' } as const],
  ])('enables nothing for a %s head and disables what the App enabled', (state, verdict) => {
    expect(types(decide(snapshot({ verdict })))).toEqual(['recordState']);
    const actions = decide(snapshot({ verdict, pull: withPull({ autoMerge: 'app' }) }));
    expect(types(actions)).toEqual(['github.disableAutoMerge', 'recordState']);
    expect(actions[1]?.input).toMatchObject({ state, reason: verdict.reason });
  });

  it('disables and enables nothing while main is red, or while paused', () => {
    for (const over of [{ main: 'red' as const }, { paused: true }]) {
      expect(types(decide(snapshot(over)))).toEqual(['recordState']);
      expect(types(decide(snapshot({ ...over, pull: withPull({ autoMerge: 'app' }) })))).toEqual([
        'github.disableAutoMerge',
        'recordState',
      ]);
    }
  });

  it('withdraws an App auto-merge when main is unknown, and enables nothing', () => {
    expect(types(decide(snapshot({ main: 'unknown' })))).toEqual(['recordState']);
    expect(
      types(decide(snapshot({ main: 'unknown', pull: withPull({ autoMerge: 'app' }) }))),
    ).toEqual(['github.disableAutoMerge', 'recordState']);
  });

  it('keeps an App auto-merge while main is pending, enables nothing, tells nobody', () => {
    expect(types(decide(snapshot({ main: 'pending' })))).toEqual(['recordState']);
    const kept = decide(snapshot({ main: 'pending', pull: withPull({ autoMerge: 'app' }) }));
    expect(types(kept)).toEqual(['recordState']);
    expect(kept[0]?.input).toMatchObject({ state: 'main-pending' });
  });

  it('re-enables after a disable with a new key, so a recovered main merges again', () => {
    const done: Record<string, ActionOutcome> = {
      [`enable:${HEAD}:0`]: { status: 'done' },
      [`disable:${HEAD}:0`]: { status: 'done' },
    };
    const actions = decide(snapshot({ done }));
    expect(actions[0]).toMatchObject({ type: 'github.enableAutoMerge', key: `enable:${HEAD}:1` });
  });

  it('does not enable twice: a withdrawn auto-merge stays withdrawn', () => {
    const done = { [`enable:${HEAD}:0`]: { status: 'done' } } as const;
    const actions = decide(snapshot({ done }));
    expect(types(actions)).toEqual(['recordState']);
    expect(actions[0]?.input).toMatchObject({ state: 'auto-merge-withdrawn' });
  });

  describe('a refused merge returns to decide', () => {
    const refusedClean: Record<string, ActionOutcome> = {
      [`enable:${HEAD}:0`]: { status: 'refused', reason: 'clean-status' },
    };

    it('clean status: merge through REST pinned to the head', () => {
      expect(decide(snapshot({ done: refusedClean, checks: PASSED }))[0]).toEqual({
        type: 'github.merge',
        key: `merge:${HEAD}`,
        input: { pullNumber: 7, sha: HEAD },
      });
    });

    it('a refused REST merge is recorded with one notification per head, not retried', () => {
      const done = {
        ...refusedClean,
        [`merge:${HEAD}`]: { status: 'refused', reason: 'status-409' },
      } as const;
      const actions = decide(snapshot({ done }));
      expect(types(actions)).toEqual(['notify', 'recordState']);
      expect(actions[0]?.key).toBe(`notify:refused:${HEAD}`);
      expect(actions[1]?.input).toMatchObject({ state: 'merge-refused', reason: 'status-409' });
    });

    it('any other refusal of auto-merge is recorded and announced, not turned into a merge', () => {
      const done = { [`enable:${HEAD}:0`]: { status: 'refused', reason: 'rejected' } } as const;
      const actions = decide(snapshot({ done }));
      expect(types(actions)).toEqual(['notify', 'recordState']);
      expect(actions[1]?.input).toMatchObject({ state: 'auto-merge-refused' });
    });

    it('a transient refusal is retried under a new key, at most three times, then announced', () => {
      let done: Record<string, ActionOutcome> = {};
      for (let n = 0; n <= MAX_TRANSIENT_RETRIES; n += 1) {
        const key = n === 0 ? `enable:${HEAD}:0` : `enable:${HEAD}:0:r${n}`;
        const next = decide(snapshot({ done }));
        expect(next[0]).toMatchObject({ type: 'github.enableAutoMerge', key });
        done = { ...done, [key]: { status: 'refused', reason: 'rejected', transient: true } };
      }
      const last = decide(snapshot({ done }));
      expect(types(last)).toEqual(['notify', 'recordState']);
      expect(last[1]?.input).toMatchObject({ state: 'auto-merge-refused' });
    });

    it('does not merge through REST unless every configured check succeeded on the head', () => {
      for (const checks of [
        [],
        [{ id: 'c', name: 'quality', status: 'running' as const }],
        [{ id: 'c', name: 'other', status: 'succeeded' as const }],
      ]) {
        const actions = decide(snapshot({ done: refusedClean, checks }));
        expect(types(actions)).toEqual(['notify', 'recordState']);
        expect(actions[0]?.key).toBe(`notify:clean-without-checks:${HEAD}`);
        expect(actions[1]?.input).toMatchObject({ state: 'clean-without-checks' });
      }
      expect(
        types(decide(snapshot({ done: refusedClean, checks: PASSED, requiredChecks: [] }))),
      ).toEqual(['notify', 'recordState']);
    });
  });

  it('never repeats an action whose key is done, and records a state once', () => {
    const first = decide(snapshot());
    const done = Object.fromEntries(first.map((a) => [a.key, { status: 'done' } as const]));
    const second = decide(snapshot({ done, pull: withPull({ autoMerge: 'app' }) }));
    expect(second.filter((a) => a.key in done)).toEqual([]);
    const settled = decide(
      snapshot({
        done,
        pull: withPull({ autoMerge: 'app' }),
        recorded: { state: 'auto-merge-enabled', reason: null, stateSeq: 1 },
      }),
    );
    expect(settled).toEqual([]);
  });

  it('records a closed or merged pull request and does nothing else', () => {
    const closed = decide(snapshot({ pull: withPull({ open: false, autoMerge: 'app' }) }));
    expect(closed).toHaveLength(1);
    expect(closed[0]?.input).toMatchObject({ state: 'closed' });
    const merged = decide(snapshot({ pull: withPull({ open: false, merged: true }) }));
    expect(merged[0]?.input).toMatchObject({ state: 'merged' });
  });

  describe('checks', () => {
    it('one notification per head for a failure', () => {
      const checks = [{ id: 'chk_1', name: 'quality', status: 'failed' as const }];
      const actions = decide(snapshot({ checks }));
      const notify = actions.find((a) => a.type === 'notify');
      expect(notify?.key).toBe(`notify:failure:${HEAD}`);
      const done = { [`notify:failure:${HEAD}`]: { status: 'done' } } as const;
      expect(decide(snapshot({ checks, done })).some((a) => a.type === 'notify')).toBe(false);
    });

    it('re-runs an errored check at most twice per head, then tells a person', () => {
      const checks = [{ id: 'chk_1', name: 'e2e', status: 'errored' as const }];
      const first = decide(snapshot({ checks }));
      expect(first.find((a) => a.type === 'checks.rerun')).toMatchObject({
        key: `rerun:${HEAD}:e2e:1`,
        input: { checkRunId: 'chk_1' },
      });
      const one = { [`rerun:${HEAD}:e2e:1`]: { status: 'done' } } as const;
      expect(
        decide(snapshot({ checks, done: one })).find((a) => a.type === 'checks.rerun'),
      ).toMatchObject({
        key: `rerun:${HEAD}:e2e:2`,
      });
      const two = { ...one, [`rerun:${HEAD}:e2e:2`]: { status: 'done' } } as const;
      const third = decide(snapshot({ checks, done: two }));
      expect(third.some((a) => a.type === 'checks.rerun')).toBe(false);
      expect(third.some((a) => a.type === 'notify' && a.key === `notify:errored:${HEAD}`)).toBe(
        true,
      );
    });

    it('a refused re-run: a full queue is retried uncounted, other refusals stop at the cap', () => {
      const checks = [{ id: 'chk_1', name: 'e2e', status: 'errored' as const }];
      const queued = {
        [`rerun:${HEAD}:e2e:1`]: { status: 'refused', reason: 'Not queued: full', transient: true },
      } as const;
      const again = decide(snapshot({ checks, done: queued }));
      expect(again.find((a) => a.type === 'checks.rerun')?.key).toBe(`rerun:${HEAD}:e2e:1`);
      expect(again.some((a) => a.type === 'notify')).toBe(false);
      let done: Record<string, ActionOutcome> = {};
      for (let n = 1; n <= MAX_REFUSED_RERUNS; n += 1) {
        expect(decide(snapshot({ checks, done })).find((a) => a.type === 'checks.rerun')?.key).toBe(
          `rerun:${HEAD}:e2e:${n}`,
        );
        done = { ...done, [`rerun:${HEAD}:e2e:${n}`]: { status: 'refused', reason: 'gone' } };
      }
      const stopped = decide(snapshot({ checks, done }));
      expect(stopped.some((a) => a.type === 'checks.rerun')).toBe(false);
      expect(stopped.some((a) => a.key === `notify:errored:${HEAD}`)).toBe(true);
    });

    it('re-runs nothing in shadow mode or while paused', () => {
      const checks = [{ id: 'chk_1', name: 'e2e', status: 'errored' as const }];
      expect(
        decide(snapshot({ checks, mode: 'shadow' })).some((a) => a.type === 'checks.rerun'),
      ).toBe(false);
      expect(
        decide(snapshot({ checks, paused: true })).some((a) => a.type === 'checks.rerun'),
      ).toBe(false);
    });
  });

  it('reports a conflict that lasted more than 24 hours, once per head', () => {
    const since = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
    const quiet = decide(
      snapshot({ pull: withPull({ conflictSince: since(CONFLICT_NOTICE_AFTER_MS - 1) }) }),
    );
    expect(quiet.some((a) => a.type === 'notify')).toBe(false);
    const loud = decide(
      snapshot({ pull: withPull({ conflictSince: since(CONFLICT_NOTICE_AFTER_MS + 1) }) }),
    );
    expect(loud.find((a) => a.type === 'notify')?.key).toBe(`notify:conflict:${HEAD}`);
  });

  it('every action input survives JSON and carries a key', () => {
    const all = [
      ...decide(snapshot({ checks: [{ id: 'c', name: 'q', status: 'failed' }] })),
      ...decide(
        snapshot({ done: { [`enable:${HEAD}:0`]: { status: 'refused', reason: 'clean-status' } } }),
      ),
      ...decide(snapshot({ checks: [{ id: 'c', name: 'q', status: 'errored' }] })),
    ];
    expect(all.length).toBeGreaterThan(3);
    for (const action of all) {
      expect(action.key.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(action))).toEqual(action);
    }
  });

  it('marks shadow notifications and keeps them quiet, deduped like in on', () => {
    const checks = [{ id: 'c', name: 'quality', status: 'failed' as const }];
    const shadow = decide(snapshot({ mode: 'shadow', checks })).find((a) => a.type === 'notify');
    expect(shadow?.input).toMatchObject({
      title: '[shadow] Dependabot checks failed',
      priority: 'min',
    });
    expect(shadow?.key).toBe(`notify:failure:${HEAD}`);
    const real = decide(snapshot({ checks })).find((a) => a.type === 'notify');
    expect(real?.input).toMatchObject({ title: 'Dependabot checks failed', priority: 'default' });
  });

  it('treats an unknown verdict like an unclassified head: nothing enabled, App auto-merge off', () => {
    const verdict = { verdict: 'unknown', reason: 'file list is incomplete' } as const;
    const actions = decide(snapshot({ verdict, pull: withPull({ autoMerge: 'app' }) }));
    expect(types(actions)).toEqual(['github.disableAutoMerge', 'recordState']);
    expect(actions[1]?.input).toMatchObject({ state: 'classification-pending' });
  });

  describe('withdrawing an App auto-merge: every mode against every reason', () => {
    const reasons: [string, Partial<DecideSnapshot>, boolean][] = [
      ['unclassified', { verdict: null }, true],
      ['ineligible', { verdict: { verdict: 'ineligible', reason: 'x' } }, true],
      ['paused', { paused: true }, true],
      ['main red', { main: 'red' }, true],
      ['main unknown', { main: 'unknown' }, true],
      ['main pending', { main: 'pending' }, false],
    ];
    for (const mode of ['off', 'shadow', 'on'] as const) {
      for (const [name, over, disables] of reasons) {
        it(`${mode} / ${name}`, () => {
          const actions = decide(snapshot({ mode, ...over, pull: withPull({ autoMerge: 'app' }) }));
          const expected = mode === 'on' ? disables : true;
          expect(actions.some((a) => a.type === 'github.disableAutoMerge')).toBe(expected);
          for (const type of ['github.enableAutoMerge', 'github.merge', 'checks.rerun']) {
            expect(actions.some((a) => a.type === type)).toBe(false);
          }
        });
      }
    }

    it('never enables or merges outside on', () => {
      for (const mode of ['off', 'shadow'] as const) {
        const actions = decide(snapshot({ mode, checks: PASSED }));
        expect(actions.some((a) => a.type === 'github.enableAutoMerge')).toBe(false);
        expect(actions.some((a) => a.type === 'github.merge')).toBe(false);
      }
    });
  });
});
