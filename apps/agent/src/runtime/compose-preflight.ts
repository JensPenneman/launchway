import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { type Document, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import { isInsideReal, PolicyError } from './workspace.js';

/** A Compose file that is not valid YAML or not a mapping, or that names a missing file. */
export class ComposeFileError extends PolicyError {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeFileError';
  }
}

export interface PreflightInput {
  /** Real path of the checkout. */
  root: string;
  /** The configured Compose files: absolute real paths inside the checkout. */
  files: readonly string[];
  /** Compose project directory (the first file's directory). */
  projectDir: string;
  /** `check`: no `include` and no top-level merge key in any file. */
  mode: 'deploy' | 'check';
}

/** Files pulling in each other deeper than this are refused. */
const MAX_DEPTH = 10;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Nodes one document may expand to through aliases and merge keys. */
const MAX_NODES = 100_000;
/** Compose's own tags and the YAML 1.2 core tags; `!!binary`, `!!merge` and others are refused. */
const ALLOWED_TAGS = new Set([
  '!reset',
  '!override',
  ...['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map(
    (name) => `tag:yaml.org,2002:${name}`,
  ),
]);
const INCLUDE_KEYS = ['path', 'env_file', 'project_directory'];
const EXTENDS_KEYS = ['service', 'file'];
const PARSE_OPTIONS = {
  version: '1.2',
  merge: true,
  uniqueKeys: true,
  prettyErrors: false,
} as const;
const MERGE = Symbol('merge');

type Entry = [key: string | typeof MERGE, value: unknown];

/** A path a Compose file names that Compose reads while it loads the project. */
interface Reference {
  /** `include path`, `service "dev" extends file`, ... */
  what: string;
  /** As written: relative (to the naming file's base directory), without variables. */
  value: string;
  /** `compose`: parsed and checked in turn; `file`, `directory`: must only stay inside. */
  kind: 'compose' | 'file' | 'directory';
  /**
   * For included files: their entry's `project_directory` and first `path`. An included file's
   * own paths are relative to its project directory: `project_directory`, else the directory of
   * the entry's first file.
   */
  include?: { projectDirectory: string | undefined; firstPath: string };
}

/**
 * Reads one parsed document the way Compose sees it: aliases resolved and merge keys expanded.
 * Every pair a merge key brings in is listed, so each value is checked whatever precedence
 * Compose gives it; a quoted `"<<"` counts as a merge key as well.
 */
class Walker {
  readonly #doc: Document.Parsed;
  readonly at: string;
  #nodes = 0;

  constructor(doc: Document.Parsed, at: string) {
    this.#doc = doc;
    this.at = at;
  }

  refuse(message: string): never {
    throw new PolicyError(`${this.at}: ${message}`);
  }

  #deref(value: unknown): unknown {
    let node = value;
    for (let hops = 0; isAlias(node); hops += 1) {
      if (hops > 100) this.refuse('YAML aliases refer to each other too deeply');
      node = node.resolve(this.#doc);
      if (node === undefined) {
        throw new ComposeFileError(`${this.at}: a YAML alias names an anchor that does not exist`);
      }
    }
    this.#nodes += 1;
    if (this.#nodes > MAX_NODES) this.refuse('YAML aliases expand to too many nodes');
    return node;
  }

  /** True for an empty value (`key:`, `~`, `null`). */
  isEmpty(value: unknown): boolean {
    const node = this.#deref(value);
    return node === null || node === undefined || (isScalar(node) && node.value === null);
  }

  /** The string of a scalar; null for any other node. */
  text(value: unknown): string | null {
    const node = this.#deref(value);
    return isScalar(node) && typeof node.value === 'string' ? node.value : null;
  }

  /** The items of a sequence; null for any other node. */
  items(value: unknown): unknown[] | null {
    const node = this.#deref(value);
    return isSeq(node) ? node.items : null;
  }

  /** The pairs of a mapping, merged ones included (after their merge key); null otherwise. */
  entries(value: unknown, depth = 0): Entry[] | null {
    const node = this.#deref(value);
    if (!isMap(node)) return null;
    if (depth > 20) this.refuse('YAML merge keys are nested too deeply');
    const out: Entry[] = [];
    for (const pair of node.items) {
      const key = this.#key(pair.key);
      out.push([key, pair.value]);
      if (key !== MERGE) continue;
      const source = this.#deref(pair.value);
      for (const item of isSeq(source) ? source.items : [source]) {
        const merged = this.entries(item, depth + 1);
        if (!merged) this.refuse('a YAML merge key (<<) must merge mappings');
        out.push(...merged);
      }
    }
    return out;
  }

  #key(value: unknown): string | typeof MERGE {
    const node = this.#deref(value);
    if (isScalar(node)) {
      if (typeof node.value === 'symbol' || node.value === '<<') return MERGE;
      if (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)) {
        return String(node.value);
      }
    }
    return this.refuse('mapping keys must be plain names');
  }
}

/** A path to a file of the repository: relative, without variables, not remote. */
function localPath(walker: Walker, what: string, value: string | null): string {
  if (value === null || value === '') return walker.refuse(`${what} must be a path`);
  if (value.includes('$')) walker.refuse(`${what} "${value}" must not use variables ($)`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^(git@|oci:)/i.test(value)) {
    walker.refuse(`${what} "${value}" is remote; only files of the repository are allowed`);
  }
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:/.test(value) || value.includes('\0')) {
    walker.refuse(`${what} "${value}" must be a relative path inside the repository`);
  }
  return value;
}

/** `include:` in deploy mode: local Compose files, env files and project directories only. */
function includeReferences(walker: Walker, value: unknown): Reference[] {
  if (walker.isEmpty(value)) return [];
  const items = walker.items(value);
  if (!items) return walker.refuse('include must be a list');
  const refs: Reference[] = [];
  for (const item of items) {
    const short = walker.text(item);
    if (short !== null) {
      refs.push({ what: 'include', value: localPath(walker, 'include', short), kind: 'compose' });
      continue;
    }
    const entries = walker.entries(item);
    if (!entries)
      return walker.refuse(
        'include entries must be paths or { path, env_file, project_directory }',
      );
    const values: Record<string, string[]> = { path: [], env_file: [], project_directory: [] };
    for (const [key, entry] of entries) {
      if (key === MERGE || walker.isEmpty(entry)) continue;
      if (!INCLUDE_KEYS.includes(key)) {
        walker.refuse(`include entries may only set ${INCLUDE_KEYS.join(', ')} (not "${key}")`);
      }
      const list = key === 'project_directory' ? null : walker.items(entry);
      for (const one of list ?? [entry]) {
        values[key]?.push(localPath(walker, `include ${key}`, walker.text(one)));
      }
    }
    const projectDirectories = values.project_directory ?? [];
    for (const dir of projectDirectories) {
      refs.push({ what: 'include project_directory', value: dir, kind: 'directory' });
    }
    const paths = values.path ?? [];
    // A merge key can bring in a second project_directory: each of them is checked.
    for (const projectDirectory of projectDirectories.length > 0
      ? projectDirectories
      : [undefined]) {
      for (const path of paths) {
        refs.push({
          what: 'include path',
          value: path,
          kind: 'compose',
          include: { projectDirectory, firstPath: paths[0] ?? path },
        });
      }
    }
    for (const file of values.env_file ?? []) {
      refs.push({ what: 'include env_file', value: file, kind: 'file' });
    }
  }
  return refs;
}

/** `services.*.extends.file`: Compose files of the repository, checked in turn. */
function extendsReferences(walker: Walker, value: unknown): Reference[] {
  if (walker.isEmpty(value)) return [];
  const services = walker.entries(value);
  if (!services) throw new ComposeFileError(`${walker.at}: services must be a mapping`);
  const refs: Reference[] = [];
  for (const [name, service] of services) {
    if (name === MERGE || walker.isEmpty(service)) continue;
    for (const [field, spec] of walker.entries(service) ?? []) {
      // `extends: <service>` names a service of the same file.
      if (field !== 'extends' || walker.isEmpty(spec) || walker.text(spec) !== null) continue;
      const what = `service "${String(name)}" extends`;
      const keys = walker.entries(spec);
      if (!keys) return walker.refuse(`${what} must be a service name or { service, file }`);
      for (const [key, entry] of keys) {
        if (key === MERGE) continue;
        if (!EXTENDS_KEYS.includes(key)) {
          walker.refuse(`${what} may only set ${EXTENDS_KEYS.join(' and ')} (not "${key}")`);
        }
        if (key === 'file' && !walker.isEmpty(entry)) {
          const file = localPath(walker, `${what} file`, walker.text(entry));
          refs.push({ what: `${what} file`, value: file, kind: 'compose' });
        }
      }
    }
  }
  return refs;
}

/** What one document pulls in; refuses what the mode does not allow. */
function referencesOf(
  walker: Walker,
  contents: unknown,
  mode: PreflightInput['mode'],
): Reference[] {
  if (walker.isEmpty(contents)) return [];
  const top = walker.entries(contents);
  if (!top) throw new ComposeFileError(`${walker.at}: the top level is not a mapping`);
  const refs: Reference[] = [];
  for (const [key, value] of top) {
    if (key === MERGE && mode === 'check') {
      walker.refuse('a top-level merge key (<<) is not allowed in checks');
    }
    if (key === 'include') {
      if (mode === 'check') {
        walker.refuse("checks do not support include; list the files in the check's Compose files");
      }
      refs.push(...includeReferences(walker, value));
    }
    if (key === 'services') refs.push(...extendsReferences(walker, value));
  }
  return refs;
}

/** Refuses explicit tags other than Compose's `!reset` / `!override` and the core schema's. */
function checkTags(doc: Document.Parsed, at: string): void {
  visit(doc, (_key, node) => {
    const tag = (node as { tag?: unknown } | null)?.tag;
    if (typeof tag === 'string' && !ALLOWED_TAGS.has(tag)) {
      throw new PolicyError(
        `${at}: the YAML tag ${tag} is not allowed (only !reset and !override)`,
      );
    }
  });
}

const unique = (values: readonly string[]) => [...new Set(values)];

/** A Compose file to check next, with the directories its relative paths resolve against. */
interface Next {
  file: string;
  bases: string[];
}

/**
 * Where a reference points, resolved like Compose does (lexically, against the base directory of
 * the file naming it): it must stay inside the checkout, symlinks resolved. Returns the Compose
 * file to check next, if it is one.
 */
async function resolveReference(
  input: PreflightInput,
  at: string,
  ref: Reference,
  base: string,
): Promise<Next | null> {
  const target = resolve(base, ref.value);
  if (!isInsideReal(input.root, target)) {
    throw new PolicyError(`${at}: ${ref.what} "${ref.value}" leaves the repository`);
  }
  if (ref.kind !== 'compose') return null;
  const file = await realpath(target).catch(() => null);
  if (!file) {
    throw new ComposeFileError(
      `${at}: ${ref.what} "${ref.value}" does not exist in the repository at this ref`,
    );
  }
  if (!ref.include) return { file, bases: [dirname(target)] };
  const { projectDirectory, firstPath } = ref.include;
  if (projectDirectory !== undefined) return { file, bases: [resolve(base, projectDirectory)] };
  // Entries with several paths: the first one's directory, or (to be safe) the file's own.
  return { file, bases: unique([dirname(resolve(base, firstPath)), dirname(target)]) };
}

async function checkComposeFile(
  input: PreflightInput,
  file: string,
  bases: readonly string[],
  depth: number,
  seen: Set<string>,
): Promise<void> {
  // The same file reached with other base directories may resolve its paths elsewhere.
  const visited = [file, ...[...bases].sort()].join('\0');
  if (seen.has(visited)) return;
  seen.add(visited);
  const at = relative(input.root, file) || file;
  if (depth > MAX_DEPTH) {
    throw new PolicyError(
      `${at}: Compose files pull in each other more than ${MAX_DEPTH} levels deep`,
    );
  }
  const info = await stat(file);
  if (!info.isFile()) throw new ComposeFileError(`${at} is not a file`);
  if (info.size > MAX_FILE_BYTES) throw new ComposeFileError(`${at} is larger than 4 MiB`);
  const docs = parseAllDocuments(await readFile(file, 'utf8'), PARSE_OPTIONS);
  const refs: Reference[] = [];
  // An empty file parses to an empty stream, which is no array.
  for (const doc of Array.isArray(docs) ? docs : []) {
    const error = doc.errors[0];
    if (error) {
      throw new ComposeFileError(`${at} is not valid YAML: ${error.message.split('\n')[0]}`);
    }
    checkTags(doc, at);
    refs.push(...referencesOf(new Walker(doc, at), doc.contents, input.mode));
  }
  for (const ref of refs) {
    for (const base of bases) {
      const next = await resolveReference(input, at, ref, base);
      if (next) await checkComposeFile(input, next.file, next.bases, depth + 1, seen);
    }
  }
}

/**
 * Reads the Compose files with a YAML parser before Compose loads them (Compose reads every file
 * they pull in, and interpolates included files from their env files, before the policy sees the
 * result): every file must parse (fail closed), `extends.file` must name a Compose file of the
 * repository (relative, no variables; checked in turn), and so must every `include` path,
 * `env_file` and `project_directory` in deploy mode; checks allow no `include` and no top-level
 * merge key. Explicit YAML tags other than `!reset` and `!override` are refused. Paths resolve
 * like Compose resolves them: in the configured files against the project directory, in an
 * included file against its project directory, in an extended file against its directory.
 */
export async function preflightComposeFiles(input: PreflightInput): Promise<void> {
  const seen = new Set<string>();
  for (const file of input.files) await checkComposeFile(input, file, [input.projectDir], 0, seen);
}
