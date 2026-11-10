// Verdict for one Dependabot pull request head (plan §3.3). Pure: no imports from the
// database, dependency, HTTP or GitHub layers; the caller gathers the input.
import { parseDependabotMetadata } from './metadata.js';

const WEB_FLOW = 'web-flow';
/** GitHub's list caps: more commits or files than this cannot be read completely. */
const MAX_COMMITS = 250;
const MAX_FILES = 3000;

export interface ClassifierPullRequest {
  authorId: number;
  authorType: string;
  headRepoId: number | null;
  baseRepoId: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  defaultBranch: string;
  draft: boolean;
  /** The PR object's own totals, to prove the lists below are complete. */
  commitCount: number;
  changedFiles: number;
}

export interface ClassifierCommit {
  sha: string;
  verified: boolean;
  authorId: number | null;
  committerLogin: string | null;
  message: string;
}

export interface ClassifierFile {
  filename: string;
  status: string;
  previousFilename?: string | null;
}

/** Per-app configuration; nothing about an app's layout is known to the classifier. */
export interface ClassifierPolicy {
  dependabotUserId: number;
  /** Path patterns; `*` matches within one path segment. */
  allowedPaths: string[];
  /** Image-name prefixes (lowercase) that are never merged unless a minor or patch update. */
  holdImages: string[];
}

export interface ClassifierInput {
  policy: ClassifierPolicy;
  pullRequest: ClassifierPullRequest;
  commits: ClassifierCommit[];
  files: ClassifierFile[];
  /** Contents of every changed package.json at the base and at the head, by path. */
  packageJson: Record<string, { base: string | null; head: string | null }>;
}

export type Verdict =
  | { verdict: 'eligible' }
  | { verdict: 'hold'; reason: string }
  | { verdict: 'ineligible'; reason: string };

function compilePattern(p: string): RegExp {
  return new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function isManifest(path: string): boolean {
  return path === 'package.json' || path.endsWith('/package.json');
}

function imageOf(dependencyName: string): string {
  const last = dependencyName.split('/').pop() ?? '';
  return (last.split('@')[0] ?? '').split(':')[0]?.toLowerCase() ?? '';
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function outsideDependencies(manifest: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest).filter(([k]) => !DEPENDENCY_FIELDS.includes(k)),
  );
}

const no = (reason: string): Verdict => ({ verdict: 'ineligible', reason });

export function classifyDependabotPullRequest(input: ClassifierInput): Verdict {
  const { policy, pullRequest: pr, commits, files } = input;

  if (pr.authorId !== policy.dependabotUserId || pr.authorType !== 'Bot') {
    return no('author is not Dependabot');
  }
  if (pr.headRepoId === null || pr.headRepoId !== pr.baseRepoId) {
    return no('head is not in the base repository');
  }
  if (!pr.headRef.startsWith('dependabot/')) return no('head branch is not dependabot/*');
  if (pr.baseRef !== pr.defaultBranch) return no('base is not the default branch');
  if (pr.draft) return no('pull request is a draft');

  if (pr.commitCount > MAX_COMMITS || commits.length !== pr.commitCount) {
    return no('commit list is incomplete');
  }
  if (pr.changedFiles > MAX_FILES || files.length !== pr.changedFiles) {
    return no('file list is incomplete');
  }
  const [commit] = commits;
  if (commits.length !== 1 || !commit) return no('not exactly one commit');
  if (commit.sha !== pr.headSha) return no('the commit is not the head');
  if (!commit.verified) return no('commit is not verified');
  if (commit.authorId !== policy.dependabotUserId) return no('commit has a foreign author');
  if (commit.committerLogin !== WEB_FLOW) return no('commit has a foreign committer');

  if (files.length === 0) return no('no changed files');
  const allowed = policy.allowedPaths.map(compilePattern);
  for (const f of files) {
    if (f.status !== 'modified') return no(`${f.filename} is ${f.status}, not modified`);
    if (!allowed.some((re) => re.test(f.filename)))
      return no(`${f.filename} is outside the allowlist`);
    if (f.previousFilename && f.previousFilename !== f.filename)
      return no(`${f.filename} was renamed`);
  }

  for (const f of files) {
    if (!isManifest(f.filename)) continue;
    const entry = input.packageJson[f.filename];
    const base = parseObject(entry?.base ?? null);
    const head = parseObject(entry?.head ?? null);
    if (!base || !head) return no(`${f.filename} cannot be compared`);
    if (!deepEqual(outsideDependencies(base), outsideDependencies(head))) {
      return no(`${f.filename} changes more than its dependencies`);
    }
  }

  const meta = parseDependabotMetadata(commit.message);
  if (!meta.ok) return no(`head commit metadata: ${meta.reason}`);

  for (const d of meta.dependencies) {
    const image = imageOf(d.name);
    if (policy.holdImages.some((h) => image.startsWith(h))) {
      if (
        d.updateType !== 'version-update:semver-minor' &&
        d.updateType !== 'version-update:semver-patch'
      ) {
        return { verdict: 'hold', reason: `${d.name}: not a minor or patch update` };
      }
    }
  }
  return { verdict: 'eligible' };
}
