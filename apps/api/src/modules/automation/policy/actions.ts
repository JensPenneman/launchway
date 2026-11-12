// Actions the automation can take and what each one returned. Pure types: every action's input is
// plain JSON and carries an idempotency key, so an action can be stored, resumed and replayed in
// another process (or another framework) without its meaning changing.

export type NotifyPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';

interface ActionBase<T extends string, I> {
  readonly type: T;
  /** An action whose key already has an outcome is never performed again. */
  readonly key: string;
  readonly input: I;
}

export type AutomationAction =
  | ActionBase<'github.disableAutoMerge', { pullNumber: number }>
  | ActionBase<'github.enableAutoMerge', { pullNumber: number; expectedHeadOid: string }>
  | ActionBase<'github.merge', { pullNumber: number; sha: string }>
  | ActionBase<'checks.rerun', { checkRunId: string }>
  | ActionBase<
      'notify',
      {
        title: string;
        priority: NotifyPriority;
        tags: string[];
        body: string;
        click: string | null;
      }
    >
  | ActionBase<'recordState', { state: string; reason: string | null }>;

/**
 * What performing an action returned. `refused` is an answer, not a failure: GitHub or the
 * Launchway checks said no for a reason `decide` can act on (a merge that is "clean status", a
 * head that changed). A failure to reach the other side throws instead and is retried.
 */
export type ActionOutcome =
  | { readonly status: 'done'; readonly detail?: string }
  | {
      readonly status: 'refused';
      readonly reason: string;
      /** The same action may succeed on a later pass (a full queue, a status still settling). */
      readonly transient?: boolean;
    };

/** Why GitHub refused to enable auto-merge: the pull request can merge right now. */
export const REFUSED_CLEAN_STATUS = 'clean-status';
