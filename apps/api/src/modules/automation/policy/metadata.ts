// Dependabot commit front matter, as `dependabot/fetch-metadata` reads it. Pure: no imports.

export interface DependabotDependency {
  name: string;
  type?: string;
  /** `version-update:semver-major` and the like; absent for docker digest bumps. */
  updateType?: string;
  group?: string;
}

export type DependabotMetadata =
  | { ok: true; dependencies: DependabotDependency[] }
  | { ok: false; reason: string };

const START = /^-{3}[ \t]*$/;
const TRAILER = /^[A-Za-z][A-Za-z-]*:[ \t].*$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0] as string)) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parses the `updated-dependencies` block of a Dependabot commit message. */
export function parseDependabotMetadata(message: string): DependabotMetadata {
  const all = message.split(/\r?\n/);
  const starts = all.flatMap((l, i) =>
    START.test(l) && all[i + 1]?.trim() === 'updated-dependencies:' ? [i] : [],
  );
  if (starts.length === 0) return { ok: false, reason: 'no updated-dependencies front matter' };
  if (starts.length > 1) return { ok: false, reason: 'more than one front matter block' };
  const start = starts[0] as number;
  const end = all.findIndex((l, i) => i > start && l.trimEnd() === '...');
  if (end < 0) return { ok: false, reason: 'front matter is not terminated' };
  if (all.slice(end + 1).some((l) => l.trim() !== '' && !TRAILER.test(l))) {
    return { ok: false, reason: 'text after the front matter' };
  }
  const lines = all.slice(start + 2, end);
  const dependencies: DependabotDependency[] = [];
  let current: Record<string, string> | null = null;
  const finish = (): string | null => {
    if (!current) return null;
    const name = current['dependency-name'];
    if (!name) return 'a dependency without dependency-name';
    dependencies.push({
      name,
      ...(current['dependency-type'] ? { type: current['dependency-type'] } : {}),
      ...(current['update-type'] ? { updateType: current['update-type'] } : {}),
      ...(current['dependency-group'] ? { group: current['dependency-group'] } : {}),
    });
    return null;
  };
  for (const line of lines) {
    if (line.trim() === '') continue;
    const item = /^-[ \t]+([A-Za-z-]+):(.*)$/.exec(line);
    const field = /^[ \t]+([A-Za-z-]+):(.*)$/.exec(line);
    if (item) {
      const problem = finish();
      if (problem) return { ok: false, reason: problem };
      current = { [item[1] as string]: unquote(item[2] as string) };
    } else if (field && current) {
      current[field[1] as string] = unquote(field[2] as string);
    } else {
      return { ok: false, reason: 'unreadable front matter line' };
    }
  }
  const problem = finish();
  if (problem) return { ok: false, reason: problem };
  if (dependencies.length === 0) return { ok: false, reason: 'no updated dependencies listed' };
  return { ok: true, dependencies };
}
