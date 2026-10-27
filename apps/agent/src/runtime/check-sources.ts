import { isUtf8 } from 'node:buffer';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { SourcePath } from './check-document.js';
import { MAX_INLINE_FILE_BYTES } from './compose-policy.js';
import { isInsideReal, realpathLenient } from './workspace.js';

const toRelative = (root: string, path: string) => relative(root, path).split(sep).join('/');

async function probe(root: string, path: string): Promise<SourcePath | null> {
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
 */
export async function probeSources(
  root: string,
  paths: readonly string[],
): Promise<Map<string, SourcePath>> {
  const found = new Map<string, SourcePath>();
  for (const path of paths) {
    if (!isInsideReal(root, path)) continue;
    const entry = await probe(root, path);
    if (entry) found.set(path, entry);
  }
  return found;
}
