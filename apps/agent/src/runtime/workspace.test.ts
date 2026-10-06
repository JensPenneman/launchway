import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertRelativePath,
  isInsideReal,
  isWithin,
  PolicyError,
  Workspace,
  writeFileReplacing,
} from './workspace.js';

let root: string;
let workspace: Workspace;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slipway-ws-'));
  workspace = new Workspace(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('paths', () => {
  it('checks containment lexically', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
  });

  it('follows symlinks, also for paths that do not exist yet', async () => {
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'sub'), { recursive: true });
    await symlink('/', join(repo, 'escape'));
    expect(isInsideReal(repo, join(repo, 'sub', 'missing', 'file'))).toBe(true);
    expect(isInsideReal(repo, join(repo, 'escape', 'etc'))).toBe(false);
    expect(isInsideReal(repo, join(repo, 'escape'))).toBe(false);
  });

  it.each(['compose.yaml', 'deploy/compose.prod.yaml', '.'])(
    'accepts the relative path %s',
    (path) => {
      expect(() => assertRelativePath(path)).not.toThrow();
    },
  );

  it.each(['/etc/passwd', '../x', 'a/../../x', '-f', 'a b'])('rejects the path %j', (path) => {
    expect(() => assertRelativePath(path)).toThrow(PolicyError);
  });
});

describe('Workspace', () => {
  it('resolves compose files and their project directory', async () => {
    const dir = join(root, 'checkout');
    await mkdir(join(dir, 'deploy'), { recursive: true });
    await writeFile(join(dir, 'deploy', 'compose.yaml'), 'services: {}');
    await writeFile(join(dir, 'compose.override.yaml'), 'services: {}');
    const source = await workspace.resolveSource(
      dir,
      { kind: 'compose', composeFiles: ['deploy/compose.yaml', 'compose.override.yaml'] },
      'synth.yaml',
    );
    expect(source.files.map((file) => file.slice(source.root.length))).toEqual([
      '/deploy/compose.yaml',
      '/compose.override.yaml',
    ]);
    expect(source.projectDir).toBe(join(source.root, 'deploy'));
  });

  it('rejects missing files, directories and symlinks leaving the repository', async () => {
    const dir = join(root, 'checkout');
    await mkdir(join(dir, 'folder'), { recursive: true });
    await symlink('/etc/hosts', join(dir, 'compose.yaml'));
    const resolve = (file: string) =>
      workspace.resolveSource(dir, { kind: 'compose', composeFiles: [file] }, 'synth.yaml');
    await expect(resolve('missing.yaml')).rejects.toThrow(/does not exist/);
    await expect(resolve('compose.yaml')).rejects.toThrow(/outside the repository/);
    await expect(resolve('folder')).rejects.toThrow(/not a file/);
  });

  it('resolves Dockerfile sources to the synthesized file', async () => {
    const dir = join(root, 'checkout');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch');
    const source = await workspace.resolveSource(
      dir,
      { kind: 'dockerfile', dockerfile: 'Dockerfile', context: '.' },
      'synth.yaml',
    );
    expect(source.files).toEqual([join(source.root, 'synth.yaml')]);
    await expect(
      workspace.resolveSource(
        dir,
        { kind: 'dockerfile', dockerfile: 'nope/Dockerfile', context: '.' },
        'synth.yaml',
      ),
    ).rejects.toThrow(PolicyError);
  });

  it('keeps the newest checkouts per app and protects the current one', async () => {
    const ids = ['dep_01a', 'dep_01b', 'dep_01c', 'dep_01d'];
    for (const id of ids) await mkdir(workspace.deploymentDir('app_1', id), { recursive: true });
    expect(await workspace.prune('app_1', 2, ['dep_01a'])).toEqual(['dep_01b']);
    expect((await readdir(workspace.appDir('app_1'))).sort()).toEqual([
      'dep_01a',
      'dep_01c',
      'dep_01d',
    ]);
    expect(await workspace.prune('missing', 2)).toEqual([]);
    await workspace.removeApp('app_1');
    await expect(stat(workspace.appDir('app_1'))).rejects.toThrow();
  });

  it('replaces files instead of writing through symlinks, with the given mode', async () => {
    const target = join(root, 'target');
    await writeFile(target, 'original');
    const link = join(root, '.env');
    await symlink(target, link);
    await writeFileReplacing(link, 'A=1\n', 0o600);
    expect((await stat(link)).mode & 0o777).toBe(0o600);
    expect((await stat(link)).isFile()).toBe(true);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(target, 'utf8')).toBe('original');
  });
});
