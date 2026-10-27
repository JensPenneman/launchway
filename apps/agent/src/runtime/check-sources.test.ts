import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeSources } from './check-sources.js';
import { MAX_INLINE_FILE_BYTES } from './compose-policy.js';

let tmp: string;
let root: string;
beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'launchway-sources-')));
  root = join(tmp, 'repo');
  await mkdir(join(root, 'docs', 'deep'), { recursive: true });
  await mkdir(join(tmp, 'outside'));
  await writeFile(join(tmp, 'outside', 'secret.txt'), 'never read');
  await writeFile(join(root, 'init.sql'), 'select $1;\n');
  await writeFile(join(root, 'limit.txt'), 'x'.repeat(MAX_INLINE_FILE_BYTES));
  await writeFile(join(root, 'big.txt'), 'x'.repeat(MAX_INLINE_FILE_BYTES + 1));
  await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  await symlink(join(root, 'docs'), join(root, 'docs-link'));
  await symlink('init.sql', join(root, 'init-link.sql'));
  await symlink(join(tmp, 'outside'), join(root, 'escape'));
  await symlink(join(root, 'nowhere'), join(root, 'dangling'));
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('probeSources', () => {
  it('describes directories, files and missing paths by their real place in the checkout', async () => {
    const paths = [
      root,
      join(root, 'docs'),
      join(root, 'docs-link', 'deep'),
      join(root, 'init.sql'),
      join(root, 'init-link.sql'),
      join(root, 'limit.txt'),
      join(root, 'big.txt'),
      join(root, 'logo.png'),
      join(root, 'cache', 'npm'),
      join(root, 'docs-link', 'new'),
    ];
    const found = await probeSources(root, paths);
    expect(Object.fromEntries(found)).toEqual({
      [root]: { kind: 'directory', relative: '' },
      [join(root, 'docs')]: { kind: 'directory', relative: 'docs' },
      [join(root, 'docs-link', 'deep')]: { kind: 'directory', relative: 'docs/deep' },
      [join(root, 'init.sql')]: {
        kind: 'file',
        relative: 'init.sql',
        size: 11,
        content: 'select $1;\n',
      },
      [join(root, 'init-link.sql')]: {
        kind: 'file',
        relative: 'init.sql',
        size: 11,
        content: 'select $1;\n',
      },
      [join(root, 'limit.txt')]: {
        kind: 'file',
        relative: 'limit.txt',
        size: MAX_INLINE_FILE_BYTES,
        content: 'x'.repeat(MAX_INLINE_FILE_BYTES),
      },
      // Too big or binary: no content, so they are mounted from the source volume.
      [join(root, 'big.txt')]: {
        kind: 'file',
        relative: 'big.txt',
        size: MAX_INLINE_FILE_BYTES + 1,
      },
      [join(root, 'logo.png')]: { kind: 'file', relative: 'logo.png', size: 6 },
      [join(root, 'cache', 'npm')]: { kind: 'missing', relative: 'cache/npm' },
      [join(root, 'docs-link', 'new')]: { kind: 'missing', relative: 'docs/new' },
    });
  });

  it('leaves out paths outside the checkout, symlinks included, and dangling links', async () => {
    const found = await probeSources(root, [
      join(tmp, 'outside', 'secret.txt'),
      join(root, 'escape', 'secret.txt'),
      join(root, 'escape'),
      join(root, '..'),
      join(root, 'dangling'),
    ]);
    expect(found.size).toBe(0);
  });
});
