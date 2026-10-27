import { isUtf8 } from 'node:buffer';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { SourcePath } from './check-document.js';
import { MAX_INLINE_FILE_BYTES } from './compose-policy.js';
import { isInsideReal, PolicyError, realpathLenient } from './workspace.js';

/** Bind sources, configs and secrets one run may name (the agent reads small files into memory). */
const MAX_PROBED_PATHS = 256;
/** Text of small files one run may read in total (configs it passes inline). */
const MAX_PROBED_BYTES = 1024 * 1024;

const toRelative = (root: string, path: string) => relative(root, path).split(sep).join('/');

/** Bytes of file text read so far by one `probeSources`. */
interface Budget {
  bytes: number;
}

async function probe(root: string, path: string, budget: Budget): Promise<SourcePath | null> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    // A missing bind source becomes a directory (as Docker creates it); a dangling link is none.
    const link = await lstat(path).then(
      () => true,
      () => false,
    );
    return link ? null : { kind: 'missing', relative: toRelative(root, realpathLenient(path)) };
  }
  const info = await stat(real);
  const rel = toRelative(root, real);
  if (info.isDirectory()) return { kind: 'directory', relative: rel };
  if (!info.isFile()) return null;
  if (info.size > MAX_INLINE_FILE_BYTES) return { kind: 'file', relative: rel, size: info.size };
  budget.bytes += info.size;
  if (budget.bytes > MAX_PROBED_BYTES) {
    throw new PolicyError(
      `The project's small files to mount or pass inline exceed ${MAX_PROBED_BYTES / 1024 / 1024} MiB in total`,
    );
  }
  const bytes = await readFile(real);
  const text = isUtf8(bytes) && !bytes.includes(0);
  return {
    kind: 'file',
    relative: rel,
    size: info.size,
    ...(text ? { content: bytes.toString('utf8') } : {}),
  };
}

/**
 * Looks at the paths a check document needs (`checkSourcePaths`): their type, the size and text
 * of small files, and their real place in the checkout `root` (a real path). Paths outside the
 * checkout, symlinks included, are left out: the policy refuses them and nothing reads them.
 * At most MAX_PROBED_PATHS paths and MAX_PROBED_BYTES of file text (a PolicyError beyond).
 */
export async function probeSources(
  root: string,
  paths: readonly string[],
): Promise<Map<string, SourcePath>> {
  if (paths.length > MAX_PROBED_PATHS) {
    throw new PolicyError(
      `The project names ${paths.length} bind mount sources, configs and secrets; checks allow at most ${MAX_PROBED_PATHS}`,
    );
  }
  const found = new Map<string, SourcePath>();
  const budget: Budget = { bytes: 0 };
  for (const path of paths) {
    if (!isInsideReal(root, path)) continue;
    const entry = await probe(root, path, budget);
    if (entry) found.set(path, entry);
  }
  return found;
}
