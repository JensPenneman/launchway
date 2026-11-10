// The merge policy (plan §3.3): `decide(snapshot) -> actions`. Pure and deterministic: no clock, no
// network, no database; the caller gathers the snapshot, performs the actions and calls `decide`
// again with their outcomes (a refused merge is an outcome that returns here, not a decision taken
// by the executor). Actions already in `done` are never emitted again, except those refused for a
// transient reason, which come back on a later pass.
import type { ActionOutcome, AutomationAction, NotifyPriority } from './actions.js';
import { REFUSED_CLEAN_STATUS } from './actions.js';
import type { Verdict } from './classify.js';

export type AutomationModeSetting = 'off' | 'shadow' | 'on';
/**
 * The default branch's head: `red` once a configured check failed there, `green` when every
 * configured check has succeeded, `pending` while some are queued, running or missing, `unknown`
 * when one errored or was cancelled or GitHub cannot tell.
 */
export type MainState = 'green' | 'red' | 'pending' | 'unknown';
export type AutoMergeState = 'none' | 'app' | 'other';

/** A Launchway check run, the newest of its name for the head. */
export interface SnapshotCheck {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'errored' | 'cancelled';
}

export interface DecideSnapshot {
  /** ISO time of the snapshot. */
  now: string;
  mode: AutomationModeSetting;
  paused: boolean;
  main: MainState;
  /** Names of the app's configured check items: the gate a merge relies on. */
  requiredChecks: string[];
  pull: {
    number: number;
    url: string;
    headSha: string;
    open: boolean;
    merged: boolean;
    /** Whether auto-merge is on, and who turned it on (`app`: this App). */
    autoMerge: AutoMergeState;
    /** Since when GitHub reports a merge conflict; null when there is none (or it is unknown). */
    conflictSince: string | null;
  };
  /** The classification of the head; null while it is not known (a new head). */
  verdict: Verdict | null;
  recorded: { state: string | null; reason: string | null; stateSeq: number };
  checks: SnapshotCheck[];
  /** Outcomes of the actions already performed for this head, by idempotency key. */
  done: Readonly<Record<string, ActionOutcome>>;
}

export const MAX_CHECK_RERUNS = 2;
/** Refused re-runs (other than a full queue) before the "errored" notice. */
export const MAX_REFUSED_RERUNS = 5;
/** Later passes for a refused enable or merge whose reason is transient. */
export const MAX_TRANSIENT_RETRIES = 3;
export const CONFLICT_NOTICE_AFTER_MS = 24 * 60 * 60 * 1000;

type NotifyAction = Extract<AutomationAction, { type: 'notify' }>;

const countKeys = (done: DecideSnapshot['done'], prefix: string): number =>
  Object.keys(done).filter((key) => key.startsWith(prefix)).length;

/** Every configured check has a newest run on the head and it succeeded. */
export function gateHolds(requiredChecks: readonly string[], checks: readonly SnapshotCheck[]) {
  return (
    requiredChecks.length > 0 &&
    requiredChecks.every((name) =>
      checks.some((check) => check.name === name && check.status === 'succeeded'),
    )
  );
}

/** Shadow notifications are marked and quiet; real ones keep their title and priority. */
function notification(
  mode: AutomationModeSetting,
  key: string,
  input: Omit<NotifyAction['input'], 'priority'> & { priority: NotifyPriority },
): NotifyAction {
  return {
    type: 'notify',
    key,
    input:
      mode === 'shadow'
        ? { ...input, title: `[shadow] ${input.title}`, priority: 'min' }
        : { ...input },
  };
}

/** Something that concerns the whole app, not one pull request (one notice per `key`). */
export type AppNotice =
  | {
      kind: 'main-unknown';
      mode: AutomationModeSetting;
      mainSha: string | null;
      /** `YYYY-MM-DDTHH`: GitHub outages an hour apart are announced each. */
      hour: string;
    }
  | {
      kind: 'handle-failed';
      mode: AutomationModeSetting;
      number: number;
      headSha: string;
      url: string | null;
    }
  | { kind: 'no-github'; mode: AutomationModeSetting; day: string }
  | {
      kind: 'no-checks';
      mode: AutomationModeSetting;
      number: number;
      headSha: string;
      url: string | null;
    }
  | { kind: 'stuck-enabled'; numbers: number[]; hour: string };

/** The notification for an app-level notice; its key is the idempotency key of the notice. */
export function appNotice(notice: AppNotice): NotifyAction {
  switch (notice.kind) {
    case 'main-unknown':
      return notification(
        notice.mode,
        `main-unknown:${notice.mainSha ?? `unreachable:${notice.hour}`}`,
        {
          title: 'Auto-merge waits',
          priority: 'low',
          tags: ['hourglass'],
          body: 'The state of the default branch is unknown (a check errored or GitHub did not answer)',
          click: null,
        },
      );
    case 'handle-failed':
      return notification(notice.mode, `handle-failed:${notice.headSha}`, {
        title: 'Dependabot automation keeps failing',
        priority: 'default',
        tags: ['warning'],
        body: `#${notice.number}: the head is not classified yet and its checks are held back`,
        click: notice.url,
      });
    case 'no-github':
      return notification(notice.mode, `no-github:${notice.day}`, {
        title: 'Automation cannot reach GitHub',
        priority: 'high',
        tags: ['warning'],
        body: 'The app has no usable GitHub App connection; Dependabot checks are held back',
        click: null,
      });
    case 'no-checks':
      return notification(notice.mode, `no-checks:${notice.headSha}`, {
        title: 'Dependabot checks did not start',
        priority: 'default',
        tags: ['warning'],
        body: `#${notice.number}: no check has run for the head after 10 minutes`,
        click: notice.url,
      });
    case 'stuck-enabled':
      return {
        type: 'notify',
        key: `stuck-enabled:${notice.hour}:${notice.numbers.join(',')}`,
        input: {
          title: 'Auto-merge could not be withdrawn',
          priority: 'urgent',
          tags: ['rotating_light'],
          body: `Still enabled: ${notice.numbers.map((n) => `#${n}`).join(', ')}`,
          click: null,
        },
      };
  }
}

export function decide(snapshot: DecideSnapshot): AutomationAction[] {
  const { pull, done, mode } = snapshot;
  const head = pull.headSha;
  const actions: AutomationAction[] = [];
  const add = (action: AutomationAction) => {
    const prior = done[action.key];
    const retry = prior?.status === 'refused' && prior.transient === true;
    if (!(action.key in done) || retry) actions.push(action);
  };
  const notify = (key: string, input: Parameters<typeof notification>[2]) =>
    add(notification(mode, key, input));
  const writes = mode === 'on' && !snapshot.paused;

  // An auto-merge this App enabled never outlives the reason it was enabled for; withdrawing it is
  // a safety action that every mode may take.
  const disable = () => {
    if (pull.autoMerge !== 'app') return;
    add({
      type: 'github.disableAutoMerge',
      key: `disable:${head}:${countKeys(done, `disable:${head}:`)}`,
      input: { pullNumber: pull.number },
    });
  };

  if (mode === 'off') {
    if (pull.open) disable();
    return actions;
  }

  const record = (state: string, reason: string | null = null) => {
    if (snapshot.recorded.state === state && snapshot.recorded.reason === reason) return;
    add({
      type: 'recordState',
      key: `state:${head}:${snapshot.recorded.stateSeq + 1}`,
      input: { state, reason },
    });
  };

  if (!pull.open) {
    record(pull.merged ? 'merged' : 'closed');
    return actions;
  }

  const verdict = snapshot.verdict;
  if (verdict === null) {
    // A head that has not been classified yet: nothing it could be merged under stays enabled.
    disable();
    return actions;
  }

  // `null`: a moment between two decisions (the next round settles it), not worth recording.
  let state: string | null;
  let reason: string | null = null;
  const refusedNotice = () =>
    notify(`notify:refused:${head}`, {
      title: 'Dependabot auto-merge was refused',
      priority: 'default',
      tags: ['warning'],
      body: `#${pull.number}: ${reason ?? 'refused'}`,
      click: pull.url,
    });

  if (verdict.verdict === 'unknown') {
    disable();
    state = 'classification-pending';
    reason = verdict.reason;
  } else if (verdict.verdict !== 'eligible') {
    disable();
    state = verdict.verdict;
    reason = verdict.reason;
  } else if (snapshot.paused) {
    disable();
    state = 'paused';
  } else if (snapshot.main === 'red') {
    disable();
    state = 'main-red';
  } else if (snapshot.main === 'unknown') {
    disable();
    state = 'main-unknown';
  } else if (snapshot.main === 'pending') {
    // No enable; an auto-merge that is on stays while the automation is on (the ruleset still
    // gates it); outside `on` nothing of the App's stays.
    if (mode !== 'on') disable();
    state = 'main-pending';
  } else if (mode === 'shadow') {
    disable();
    state = 'shadow';
    reason = 'would enable auto-merge';
  } else if (pull.autoMerge === 'other') {
    state = 'auto-merge-by-other';
  } else if (pull.autoMerge === 'app') {
    state = 'auto-merge-enabled';
  } else {
    const base = `enable:${head}:${countKeys(done, `disable:${head}:`)}`;
    const mergeBase = `merge:${head}`;
    // The newest attempt of an action that may be retried: its key and outcome (if any), and how
    // many earlier attempts were refused for a transient reason.
    const attempt = (prefix: string) => {
      for (let retries = 0; ; retries += 1) {
        const key = retries === 0 ? prefix : `${prefix}:r${retries}`;
        const outcome = done[key];
        if (outcome === undefined) return { key, outcome, retries, exhausted: false };
        const transient = outcome.status === 'refused' && outcome.transient === true;
        if (!transient) return { key, outcome, retries, exhausted: false };
        if (retries >= MAX_TRANSIENT_RETRIES) return { key, outcome, retries, exhausted: true };
      }
    };
    const enabled = attempt(base);
    if (enabled.outcome === undefined) {
      add({
        type: 'github.enableAutoMerge',
        key: enabled.key,
        input: { pullNumber: pull.number, expectedHeadOid: head },
      });
      state = enabled.retries > 0 ? 'auto-merge-retrying' : null;
    } else if (
      enabled.outcome.status === 'refused' &&
      enabled.outcome.reason === REFUSED_CLEAN_STATUS
    ) {
      const merged = attempt(mergeBase);
      if (merged.outcome === undefined) {
        if (gateHolds(snapshot.requiredChecks, snapshot.checks)) {
          add({
            type: 'github.merge',
            key: merged.key,
            input: { pullNumber: pull.number, sha: head },
          });
          state = merged.retries > 0 ? 'merge-retrying' : null;
        } else {
          // GitHub would merge, but Launchway's own checks do not vouch for this head.
          state = 'clean-without-checks';
          reason = 'the configured checks have not all succeeded for the head';
          notify(`notify:clean-without-checks:${head}`, {
            title: 'Dependabot merge waits for checks',
            priority: 'default',
            tags: ['warning'],
            body: `#${pull.number} could merge, but its checks have not all succeeded`,
            click: pull.url,
          });
        }
      } else if (merged.outcome.status === 'refused') {
        reason = merged.outcome.reason;
        state = 'merge-refused';
        refusedNotice();
      } else {
        state = 'merged';
      }
    } else if (enabled.outcome.status === 'refused') {
      reason = enabled.outcome.reason;
      state = 'auto-merge-refused';
      refusedNotice();
    } else {
      state = 'auto-merge-withdrawn';
    }
  }

  const failed = snapshot.checks.filter((check) => check.status === 'failed');
  if (failed.length > 0) {
    notify(`notify:failure:${head}`, {
      title: 'Dependabot checks failed',
      priority: 'default',
      tags: ['x'],
      body: `#${pull.number}: ${failed.map((check) => check.name).join(', ')} failed`,
      click: pull.url,
    });
  }
  const exhausted: string[] = [];
  for (const check of snapshot.checks.filter((c) => c.status === 'errored')) {
    const prefix = `rerun:${head}:${encodeURIComponent(check.name)}:`;
    let reran = 0;
    let refused = 0;
    for (const [key, outcome] of Object.entries(done)) {
      if (!key.startsWith(prefix)) continue;
      if (outcome.status === 'done') reran += 1;
      else if (outcome.transient !== true) refused += 1;
    }
    if (reran >= MAX_CHECK_RERUNS || refused >= MAX_REFUSED_RERUNS) {
      exhausted.push(check.name);
    } else if (writes) {
      add({
        type: 'checks.rerun',
        key: `${prefix}${reran + refused + 1}`,
        input: { checkRunId: check.id },
      });
    }
  }
  if (exhausted.length > 0) {
    notify(`notify:errored:${head}`, {
      title: 'Dependabot checks errored',
      priority: 'default',
      tags: ['warning'],
      body: `#${pull.number}: ${exhausted.join(', ')} errored and could not be re-run`,
      click: pull.url,
    });
  }

  if (
    pull.conflictSince !== null &&
    Date.parse(snapshot.now) - Date.parse(pull.conflictSince) > CONFLICT_NOTICE_AFTER_MS
  ) {
    notify(`notify:conflict:${head}`, {
      title: 'Dependabot pull request conflicts',
      priority: 'default',
      tags: ['warning'],
      body: `#${pull.number} has conflicted with the default branch for over 24 hours`,
      click: pull.url,
    });
  }

  if (state !== null) record(state, reason);
  return actions;
}
