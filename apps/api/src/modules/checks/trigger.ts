import type { AppChecksSettings } from '@launchway/contracts';

/** An account of a webhook payload or a pull request. */
interface Account {
  login: string;
  type: string;
}

/** Bots: GitHub's account type, or the `[bot]` login suffix of GitHub Apps (`dependabot[bot]`). */
export function isBot(account: Account | null | undefined): boolean {
  return account?.type === 'Bot' || account?.login.endsWith('[bot]') === true;
}

/** The push or pull request a check decision is about. */
export type CheckEvent =
  | {
      readonly kind: 'push';
      readonly branch: string;
      /** Who pushed. */
      readonly sender: Account | null | undefined;
    }
  | {
      readonly kind: 'pull_request';
      /** The branch the pull request merges into; null when the event does not name it. */
      readonly baseBranch: string | null;
      readonly author: Account | null | undefined;
    };

/**
 * Whether a push to a branch, or a pull request from a branch of the repository, runs the checks
 * of an app with these settings (ADR 0020): checks on and configured, `branches` (null: every
 * branch) holding the pushed branch or the pull request's base branch, and with `skipBots` no
 * bot as the pusher or the pull request's author. Forks never get here. Manual runs
 * (`POST /apps/{id}/checks`) apply none of this.
 */
export function checkTrigger(
  settings: Pick<AppChecksSettings, 'enabled' | 'branches' | 'skipBots' | 'items'>,
  event: CheckEvent,
): { readonly run: true } | { readonly run: false; readonly reason: string } {
  const skip = (reason: string) => ({ run: false, reason }) as const;
  if (!settings.enabled) return skip('checks are off for the app');
  if (settings.items.length === 0) return skip('the app has no checks');
  const push = event.kind === 'push';
  const branch = push ? event.branch : event.baseBranch;
  if (settings.branches !== null && (branch === null || !settings.branches.includes(branch))) {
    return skip(
      push
        ? `pushes to ${branch} run no checks`
        : `pull requests into ${branch ?? 'an unnamed base branch'} run no checks`,
    );
  }
  const account = push ? event.sender : event.author;
  if (settings.skipBots && isBot(account)) {
    return skip(`${push ? 'pushed' : 'opened'} by the bot ${account?.login}`);
  }
  return { run: true };
}
