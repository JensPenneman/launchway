import { constants, existsSync, realpathSync } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type AppSource, RELATIVE_PATH_PATTERN } from '@launchway/contracts';

/** A rule violation that should fail the deployment with `policy-violation`. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** A file the configuration names is missing or not a file (a PolicyError for deployments). */
export class MissingFileError extends PolicyError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingFileError';
  }
}

/** True when `child` is `root` or below it (both absolute, already normalized). */
export function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Realpath of `path`, or of its nearest existing ancestor joined with the missing rest. */
export function realpathLenient(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length).replace(/^[/\\]/, ''));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

/** Containment check that follows symlinks, so a link inside the repository cannot point out. */
export function isInsideReal(root: string, path: string): boolean {
  try {
    return isWithin(realpathSync(root), realpathLenient(path));
  } catch {
    return false;
  }
}

/** Validates a repository-relative path from the payload (defence in depth after Zod). */
export function assertRelativePath(path: string): void {
  if (!RELATIVE_PATH_PATTERN.test(path) || path.length > 255) {
    throw new PolicyError(`"${path.slice(0, 80)}" is not a relative path inside the repository`);
  }
}

export interface ResolvedSource {
  /** Real path of the checkout. */
  root: string;
  /** Absolute Compose files in merge order (the synthesized file for Dockerfile apps). */
  files: string[];
  /** Compose project directory: the directory of the first file (Compose's own default). */
  projectDir: string;
}

/**
 * On-disk layout under LAUNCHWAY_WORKSPACE: `apps/<appId>/<deploymentId>` checkouts,
 * `checks/<appId>/<runId>` check runs and an empty directory used as the working directory for
 * project-only Compose commands.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  appDir(appId: string): string {
    return join(this.root, 'apps', appId);
  }

  deploymentDir(appId: string, deploymentId: string): string {
    return join(this.appDir(appId), deploymentId);
  }

  /** An empty directory, so `docker compose -p <project> ...` never picks up a stray file. */
  async neutralDir(): Promise<string> {
    const dir = join(this.root, 'agent', 'compose-cwd');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async prepareDeploymentDir(appId: string, deploymentId: string): Promise<string> {
    const dir = this.deploymentDir(appId, deploymentId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(this.appDir(appId), { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Keeps the newest `keep` deployment directories of an app (deployment ids are UUIDv7 based,
   * so they sort by creation time) plus any in `protect`; deletes the rest.
   */
  async prune(appId: string, keep: number, protect: readonly string[] = []): Promise<string[]> {
    let names: string[];
    try {
      names = (await readdir(this.appDir(appId), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('dep_'))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
    const doomed = names
      .slice(0, Math.max(0, names.length - keep))
      .filter((n) => !protect.includes(n));
    for (const name of doomed) {
      await rm(join(this.appDir(appId), name), { recursive: true, force: true });
    }
    return doomed;
  }

  async removeApp(appId: string): Promise<void> {
    await rm(this.appDir(appId), { recursive: true, force: true });
  }

  /** Every check run's directory; nothing in it outlives its run. */
  checksDir(): string {
    return join(this.root, 'checks');
  }

  /**
   * BUILDX_CONFIG of the commands of checks: buildx keeps the check builder's records here, in the
   * agent's volume, so a new agent container still knows the builder (and its cache).
   */
  async buildxDir(): Promise<string> {
    const dir = join(this.root, 'agent', 'buildx');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** `src` (the checkout) plus the run's `compose.json` and `check.env`, outside the checkout. */
  checkRunDir(appId: string, runId: string): string {
    return join(this.checksDir(), appId, runId);
  }

  async prepareCheckRunDir(appId: string, runId: string): Promise<string> {
    const dir = this.checkRunDir(appId, runId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Deletes a run's directory, and the app's directory once it is empty. */
  async removeCheckRunDir(appId: string, runId: string): Promise<void> {
    await rm(this.checkRunDir(appId, runId), { recursive: true, force: true });
    await rmdir(join(this.checksDir(), appId)).catch(() => undefined);
  }

  async removeChecks(): Promise<void> {
    await rm(this.checksDir(), { recursive: true, force: true });
  }

  /**
   * Resolves the build source inside a checkout: Compose files must exist and stay inside the
   * repository (symlinks included). Dockerfile apps get a synthesized file at the root.
   */
  async resolveSource(
    checkoutDir: string,
    build: AppSource,
    synthesizedFile: string,
  ): Promise<ResolvedSource> {
    const root = await realpath(checkoutDir);
    if (build.kind === 'dockerfile') {
      for (const path of [build.dockerfile, build.context]) {
        assertRelativePath(path);
        await this.#assertExisting(root, path);
      }
      return { root, files: [join(root, synthesizedFile)], projectDir: root };
    }
    return this.resolveComposeFiles(root, build.composeFiles);
  }

  /** Compose files of a checkout, in merge order; the first one's directory is the project's. */
  async resolveComposeFiles(
    checkoutDir: string,
    composeFiles: readonly string[],
  ): Promise<ResolvedSource> {
    const root = await realpath(checkoutDir);
    const files: string[] = [];
    for (const file of composeFiles) {
      assertRelativePath(file);
      const real = await this.#assertExisting(root, file);
      const info = await stat(real);
      if (!info.isFile()) throw new MissingFileError(`Compose file "${file}" is not a file`);
      files.push(real);
    }
    const first = files[0];
    if (!first) throw new MissingFileError('No Compose file configured');
    return { root, files, projectDir: dirname(first) };
  }

  async #assertExisting(root: string, path: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(join(root, path));
    } catch {
      throw new MissingFileError(`"${path}" does not exist in the repository at this ref`);
    }
    if (!isWithin(root, real)) throw new PolicyError(`"${path}" points outside the repository`);
    return real;
  }
}

/**
 * Opens `path` for reading without blocking on a FIFO; with `noFollow`, a symlink in its last
 * component fails instead of being followed. Callers stat and read through the handle, so what
 * they check is what they read.
 */
export function openForReading(path: string, noFollow = false): Promise<FileHandle> {
  const flags =
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
  return open(path, flags);
}

/** Reads at most `limit` bytes from the start of an open file (fewer at its end). */
export async function readUpTo(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** Writes a file with `mode`, replacing (not following) whatever the repository put there. */
export async function writeFileReplacing(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await writeFile(path, content, { mode, flag: 'wx' });
}
