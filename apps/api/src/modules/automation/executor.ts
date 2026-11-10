// The one executor of the automation: performs the actions `decide` returns and nothing else.
// It holds no policy: a refusal (GitHub says "clean status", the head moved) is returned as an
// outcome for `decide` to act on, and only a failure to reach the other side throws.
import type { CheckRunId } from '@launchway/contracts';
import type { Deps } from '../../deps.js';
import { systemActor } from '../../lib/auth-context.js';
import { ProblemError } from '../../lib/problem.js';
import { recordAudit } from '../audit/service.js';
import { createChecksService } from '../checks/service.js';
import { createNotifier, type NotifyResult } from '../notifications/ntfy.js';
import type { AutomationGitHub, PullDetail } from './github.js';
import type { ActionOutcome, AutomationAction } from './policy/actions.js';

/** What an action may touch; never part of an action's stored input. */
export interface ExecutionContext {
  readonly appId: string;
  readonly github: AutomationGitHub;
  readonly pull: PullDetail;
}

export type PerformableAction = Exclude<
  AutomationAction,
  { type: 'notify' } | { type: 'recordState' }
>;

export function createAutomationExecutor(deps: Deps) {
  const actor = systemActor('automation');
  const checks = createChecksService(deps);
  const notifier = createNotifier(deps);

  async function audit(
    appId: string,
    action: string,
    summary: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(deps.db, actor, {
      action,
      target: { type: 'app', id: appId },
      summary,
    });
  }

  return {
    /** Performs one GitHub or checks action. Throws when the other side cannot be reached. */
    async perform(action: PerformableAction, ctx: ExecutionContext): Promise<ActionOutcome> {
      switch (action.type) {
        case 'github.enableAutoMerge': {
          const result = await ctx.github.enableAutoMerge(ctx.pull, action.input.expectedHeadOid);
          if ('refused' in result) {
            return { status: 'refused', reason: result.refused, transient: result.transient };
          }
          await audit(ctx.appId, 'automation.auto-merge.enable', {
            pull: action.input.pullNumber,
            head: action.input.expectedHeadOid,
          });
          return { status: 'done' };
        }
        case 'github.disableAutoMerge': {
          const result = await ctx.github.disableAutoMerge(ctx.pull);
          // A disable that GitHub did not do is a failure, never an outcome: the head must not
          // go on as if the auto-merge were off.
          if ('refused' in result) {
            throw new Error(`GitHub refused to disable auto-merge: ${result.message}`);
          }
          await audit(ctx.appId, 'automation.auto-merge.disable', {
            pull: action.input.pullNumber,
          });
          return { status: 'done' };
        }
        case 'github.merge': {
          const result = await ctx.github.merge(action.input.pullNumber, action.input.sha);
          if ('refused' in result) {
            return { status: 'refused', reason: result.refused, transient: result.transient };
          }
          await audit(ctx.appId, 'automation.merge', {
            pull: action.input.pullNumber,
            head: action.input.sha,
          });
          return { status: 'done' };
        }
        case 'checks.rerun': {
          try {
            await checks.rerun(action.input.checkRunId as CheckRunId, actor);
            return { status: 'done' };
          } catch (error) {
            // A full queue, a check that was removed, a run already active: answers, not failures.
            if (error instanceof ProblemError && error.type !== 'upstream-failed') {
              const reason = error.detail?.slice(0, 200) ?? error.type;
              // A full queue clears by itself; any other refusal is final for this attempt.
              return { status: 'refused', reason, transient: reason.startsWith('Not queued:') };
            }
            throw error;
          }
        }
      }
    },

    /** Sends one notification (three tries; never throws). Never call it from a webhook handler. */
    deliver(action: Extract<AutomationAction, { type: 'notify' }>): Promise<NotifyResult> {
      const { title, priority, tags, body, click } = action.input;
      return notifier({ title, priority, tags, body, ...(click === null ? {} : { click }) });
    },
  };
}
