import { GIT_REF_PATTERN } from '@launchway/contracts';

/** Extra `git -c key=value` settings, passed through `GIT_CONFIG_*` (never argv, never disk). */
export type GitConfig = readonly (readonly [key: string, value: string])[];

/**
 * Environment for git. The Authorization header travels as `http.extraHeader` through
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`: the same as `git -c`, but not
 * visible in the process list and never written to `.git/config`.
 */
export function gitEnv(
  authorization: string | null,
  extra: GitConfig = [],
): Record<string, string> {
  const entries: [string, string][] = [
    ['credential.helper', ''],
    ['core.askPass', ''],
    ['advice.detachedHead', 'false'],
    ...extra.map(([key, value]): [string, string] => [key, value]),
  ];
  if (authorization) entries.push(['http.extraHeader', `Authorization: ${authorization}`]);
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** Throws unless `ref` is safe to pass to git (spec section 9). */
export function assertSafeRef(ref: string): void {
  if (ref.length === 0 || ref.length > 255 || !GIT_REF_PATTERN.test(ref)) {
    throw new RangeError(`Refusing unsafe git ref "${ref.slice(0, 80)}"`);
  }
}

/** True when the ref names the commit itself (full or abbreviated SHA) rather than a tag/branch. */
export function isCommitRef(ref: string, commitSha: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(ref) && commitSha.startsWith(ref);
}

export interface CheckoutPlan {
  /** Commands to run in order (`cwd` = the checkout directory unless `inParent`). */
  steps: { args: string[]; inParent?: boolean }[];
}

/**
 * Git commands for a shallow checkout: `clone --depth 1 --branch <ref>` for tags and branches,
 * `init` + `fetch --depth 1 origin <sha>` + `checkout` for commits.
 */
export function checkoutPlan(
  cloneUrl: string,
  ref: string,
  commitSha: string,
  dir: string,
): CheckoutPlan {
  assertSafeRef(ref);
  if (isCommitRef(ref, commitSha)) return fetchCommitPlan(cloneUrl, commitSha, dir, true);
  return {
    steps: [
      {
        args: [
          'clone',
          '--depth',
          '1',
          '--single-branch',
          '--no-tags',
          '--branch',
          ref,
          '--',
          cloneUrl,
          dir,
        ],
        inParent: true,
      },
    ],
  };
}

/** Fetches one commit by SHA into `dir` (initializing the repository first when asked). */
export function fetchCommitPlan(
  cloneUrl: string,
  commitSha: string,
  dir: string,
  init: boolean,
): CheckoutPlan {
  const steps: CheckoutPlan['steps'] = [];
  if (init) {
    steps.push({ args: ['init', '--quiet', '--', dir], inParent: true });
    steps.push({ args: ['remote', 'add', 'origin', '--', cloneUrl] });
  }
  steps.push({ args: ['fetch', '--depth', '1', '--no-tags', 'origin', commitSha] });
  steps.push({ args: ['checkout', '--quiet', '--detach', commitSha] });
  return { steps };
}
