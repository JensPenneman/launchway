import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ComposeFileError,
  type PreflightInput,
  preflightComposeFiles,
} from './compose-preflight.js';
import { PolicyError } from './workspace.js';

let tmp: string;
let root: string;
let outside: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'launchway-preflight-')));
  root = join(tmp, 'repo');
  outside = join(tmp, 'outside');
  await mkdir(join(root, '.devcontainer'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'compose.yaml'), 'services:\n  x:\n    image: alpine:3\n');
  await writeFile(join(outside, 'secrets.env'), 'DATABASE_PASSWORD=hunter2\n');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Writes files of the checkout (paths relative to it). */
async function repo(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function preflight(mode: PreflightInput['mode'], files = ['.devcontainer/compose.yaml']) {
  const absolute = files.map((file) => join(root, file));
  const first = absolute[0] ?? root;
  return preflightComposeFiles({ root, files: absolute, projectDir: dirname(first), mode });
}

const TRAIL = `name: \${COMPOSE_PROJECT_NAME:?start the development container with scripts/devc.sh}
x-node: &node
  init: true
  environment: &env
    LOG_LEVEL: debug
services:
  dev:
    <<: *node
    build:
      context: ..
      dockerfile: .devcontainer/Dockerfile
    environment:
      <<: *env
      DATABASE_URL: postgres://trail:trail@db:5432/trail
    volumes:
      - ..:/workspaces/trail
      - node-modules:/workspaces/trail/node_modules
    ports: !reset []
    depends_on:
      db:
        condition: service_healthy
  worker:
    extends: dev
    command: !override ["npm", "run", "worker"]
  db:
    extends:
      file: ../compose.base.yaml
      service: db
    volumes:
      - ../scripts/db/init-dev.sql:/docker-entrypoint-initdb.d/10-databases.sql:ro
volumes:
  node-modules:
---
services:
  extra:
    image: !!str alpine:3
`;

describe('preflightComposeFiles', () => {
  it.each(['check', 'deploy'] as const)(
    'accepts a dev container with anchors, merge keys, tags and extends (%s)',
    async (mode) => {
      await repo({
        '.devcontainer/compose.yaml': TRAIL,
        'compose.base.yaml': 'services:\n  db:\n    image: postgres:18-alpine\n',
      });
      await expect(preflight(mode)).resolves.toBeUndefined();
    },
  );

  it('accepts empty files and files of comments', async () => {
    await repo({ '.devcontainer/compose.yaml': '', 'other.yaml': '# nothing\n' });
    await expect(preflight('check', ['.devcontainer/compose.yaml', 'other.yaml'])).resolves.toBe(
      undefined,
    );
  });

  describe('in check mode', () => {
    it.each<[string, string]>([
      ['a plain include', 'include:\n  - ../other.yaml\n'],
      ['an include of a file inside the repository', 'include: [compose.more.yaml]\n'],
      ['a quoted key', '"include": [../other.yaml]\n'],
      ['an escaped key', '"\\x69nclude": [../other.yaml]\n'],
      ['an escaped line break in an explicit key', '? "inc\\\n  lude"\n: [../other.yaml]\n'],
      ['an alias as key', 'x-k: &k include\n*k : [../other.yaml]\n'],
      ['a flow mapping', '{include: [../other.yaml], services: {}}\n'],
      ['a complex key', '? include\n: [../other.yaml]\n'],
      ['a second document', 'services: {}\n---\ninclude: [../other.yaml]\n'],
    ])('refuses %s', async (_label, compose) => {
      await repo({ '.devcontainer/compose.yaml': compose, '.devcontainer/compose.more.yaml': '' });
      await expect(preflight('check')).rejects.toThrow(
        /^\.devcontainer\/compose\.yaml: checks do not support include; list the files in the check's Compose files$/,
      );
    });

    it.each<[string, string]>([
      ['a top-level merge of an anchor', 'x-a: &a\n  include: [../other.yaml]\n<<: *a\n'],
      ['a top-level merge of a list', 'x-a: &a {services: {}}\n<<: [*a]\n'],
      ['a quoted merge key', '"<<": {services: {}}\n'],
    ])('refuses %s', async (_label, compose) => {
      await repo({ '.devcontainer/compose.yaml': compose });
      await expect(preflight('check')).rejects.toThrow(
        /a top-level merge key \(<<\) is not allowed in checks/,
      );
    });

    it('checks extended files the same way, recursively', async () => {
      await repo({
        '.devcontainer/compose.yaml':
          'services:\n  dev:\n    extends: {file: base.yaml, service: dev}\n',
        '.devcontainer/base.yaml':
          'services:\n  dev:\n    extends: {file: ../deeper.yaml, service: dev}\n',
        'deeper.yaml': 'include: [x.yaml]\nservices:\n  dev:\n    image: alpine:3\n',
      });
      await expect(preflight('check')).rejects.toThrow(
        /^deeper\.yaml: checks do not support include/,
      );
    });
  });

  describe.each(['check', 'deploy'] as const)('extends.file (%s)', (mode) => {
    const extending = (file: string) =>
      `services:\n  dev:\n    extends:\n      file: ${file}\n      service: x\n`;

    it.each<[string, string, RegExp]>([
      [
        'an absolute path',
        `${'/'}etc/compose.yaml`,
        /must be a relative path inside the repository/,
      ],
      ['a home directory path', '~/compose.yaml', /must be a relative path inside the repository/],
      ['a path out of the repository', '../../outside/compose.yaml', /leaves the repository/],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, kept literally
      ['a variable', '${HOME}/compose.yaml', /must not use variables/],
      ['an escaped dollar', '"$$x.yaml"', /must not use variables/],
      ['a remote file', 'https://example.com/compose.yaml', /is remote/],
      ['a symlink out of the repository', 'escape/compose.yaml', /leaves the repository/],
      ['a non-string', '[a.yaml]', /extends file must be a path/],
      ['a missing file', 'missing.yaml', /does not exist in the repository at this ref/],
    ])('refuses %s', async (_label, file, pattern) => {
      await repo({ '.devcontainer/compose.yaml': extending(file) });
      await symlink(outside, join(root, '.devcontainer', 'escape'));
      await expect(preflight(mode)).rejects.toThrow(pattern);
    });

    it.each<[string, string]>([
      [
        'a merge key in the service',
        'x-base: &base\n  extends: {file: ../../outside/compose.yaml, service: x}\nservices:\n  dev:\n    <<: *base\n',
      ],
      [
        'an alias for the service',
        'x-base: &base\n  extends: {file: ../../outside/compose.yaml, service: x}\nservices:\n  dev: *base\n',
      ],
      [
        'an alias for the extends mapping',
        'x-ext: &ext {file: ../../outside/compose.yaml, service: x}\nservices:\n  dev:\n    extends: *ext\n',
      ],
      [
        'a merge key that loses to an explicit key',
        'x-ext: &ext {file: ../../outside/compose.yaml}\nservices:\n  dev:\n    extends: {<<: *ext, file: ok.yaml, service: x}\n',
      ],
      [
        'a merged list of services',
        'x-s: &s\n  dev:\n    extends: {file: ../../outside/compose.yaml, service: x}\nservices:\n  <<: *s\n',
      ],
    ])('finds paths behind %s', async (_label, compose) => {
      await repo({ '.devcontainer/compose.yaml': compose, '.devcontainer/ok.yaml': '' });
      await expect(preflight(mode)).rejects.toThrow(/leaves the repository/);
    });

    it('is cycle-safe and bounded in depth', async () => {
      await repo({
        '.devcontainer/compose.yaml': extending('a.yaml'),
        '.devcontainer/a.yaml': extending('compose.yaml'),
      });
      await expect(preflight(mode)).resolves.toBeUndefined();
      const chain: Record<string, string> = {};
      for (let i = 0; i < 12; i += 1)
        chain[`.devcontainer/c${i}.yaml`] = extending(`c${i + 1}.yaml`);
      chain['.devcontainer/c12.yaml'] = '';
      chain['.devcontainer/compose.yaml'] = extending('c0.yaml');
      await repo(chain);
      await expect(preflight(mode)).rejects.toThrow(/more than 10 levels deep/);
    });
  });

  describe.each(['check', 'deploy'] as const)('resolves paths like Compose (%s)', (mode) => {
    const extending = (file: string) =>
      `services:\n  x:\n    extends:\n      file: ${file}\n      service: x\n`;

    it('refuses a path that leaves the repository from any base Compose might use', async () => {
      // The reviewer's layout: the project directory is a/b/c/d (the first file's), top.yaml sits
      // at the root. Compose 5.6 resolves top.yaml's paths against a/b/c/d; other versions may use
      // top.yaml's own directory, from where ../../../../ reaches the agent workspace.
      const files = ['a/b/c/d/compose.yaml', 'top.yaml'];
      await repo({ 'a/b/c/d/compose.yaml': 'services: {}\n', 'x.yaml': '', 'a/b/c/d/x.yaml': '' });
      for (const reference of [
        extending('../../../../x.yaml'),
        `services:\n  x:\n    image: alpine:3\n    label_file: [../../../../apps/app_1/dep_1/.env]\n`,
        `services:\n  x:\n    image: alpine:3\n    env_file: [{path: ../../../../.env}]\n`,
      ]) {
        await repo({ 'top.yaml': reference });
        await expect(preflight(mode, files)).rejects.toThrow(
          /^top\.yaml: .* leaves the repository$/,
        );
      }
      // Inside from every base: fine.
      await repo({ 'top.yaml': extending('x.yaml') });
      await expect(preflight(mode, files)).resolves.toBeUndefined();
    });

    it('resolves paths of an extended file against its own directory', async () => {
      await repo({
        '.devcontainer/compose.yaml': extending('../shared/base.yaml'),
        'shared/base.yaml': extending('../.devcontainer/inner.yaml'),
        '.devcontainer/inner.yaml': '',
      });
      await expect(preflight(mode)).resolves.toBeUndefined();
      await repo({ 'shared/base.yaml': extending('../../inner.yaml') });
      await expect(preflight(mode)).rejects.toThrow(
        /^shared\/base\.yaml: .* leaves the repository$/,
      );
    });
  });

  describe.each(['check', 'deploy'] as const)('env_file and label_file (%s)', (mode) => {
    const service = (field: string) => `services:\n  web:\n    image: alpine:3\n    ${field}\n`;

    it('accepts files of the repository, short and long syntax', async () => {
      await repo({
        '.devcontainer/compose.yaml': service(
          'env_file: [.env, {path: ../config/app.env, required: false}, {path: ./more.env, format: raw}]\n    label_file: ../config/labels',
        ),
      });
      await expect(preflight(mode)).resolves.toBeUndefined();
    });

    it.each<[string, string, RegExp]>([
      [
        'an absolute env file',
        'env_file: [/var/lib/launchway/agent/credentials.json]',
        /service "web" env_file "\/var\/lib\/launchway\/agent\/credentials\.json" must be a relative path/,
      ],
      [
        'an env file out of the repository',
        'env_file: ../../outside/secrets.env',
        /service "web" env_file "\.\.\/\.\.\/outside\/secrets\.env" leaves the repository/,
      ],
      [
        'a label file through a symlink out of the repository',
        'label_file: escape/secrets.env',
        /service "web" label_file "escape\/secrets\.env" leaves the repository/,
      ],
      [
        'a label file with a variable',
        'label_file: ["$HOME/labels"]',
        /service "web" label_file "\$HOME\/labels" must not use variables/,
      ],
      [
        'an env file in long syntax out of the repository',
        'env_file: [{path: ../../outside/secrets.env}]',
        /leaves the repository/,
      ],
      [
        'an unknown key in long syntax',
        'env_file: [{path: .env, mode: x}]',
        /env_file entries may only set path, required, format \(not "mode"\)/,
      ],
      ['a label file in long syntax', 'label_file: [{path: labels}]', /must be a path or a list/],
    ])('refuses %s', async (_label, field, pattern) => {
      await repo({ '.devcontainer/compose.yaml': service(field) });
      await symlink(outside, join(root, '.devcontainer', 'escape'));
      await expect(preflight(mode)).rejects.toThrow(pattern);
    });
  });

  describe('in deploy mode', () => {
    it('resolves paths of an included file against its project directory', async () => {
      await repo({
        '.devcontainer/compose.yaml': 'include:\n  - ../shared/compose.yaml\n',
        'shared/compose.yaml': 'services:\n  x:\n    extends: {file: base.yaml, service: x}\n',
        'shared/base.yaml': '',
      });
      await expect(preflight('deploy')).resolves.toBeUndefined();
      // With project_directory ../a/b/c, ../../../.. leaves the repository, though from the
      // included file's own directory it would not.
      await repo({
        '.devcontainer/compose.yaml':
          'include:\n  - path: ../shared/compose.yaml\n    project_directory: ../a/b/c\n',
        'shared/compose.yaml':
          'services:\n  x:\n    extends: {file: ../../../../base.yaml, service: x}\n',
        'a/b/c/.keep': '',
      });
      await expect(preflight('deploy')).rejects.toThrow(
        /^shared\/compose\.yaml: service "x" extends file ".*" leaves the repository$/,
      );
    });

    it('accepts includes of files of the repository, short and long syntax', async () => {
      await repo({
        '.devcontainer/compose.yaml': [
          'include:',
          '  - ../shared/db.yaml',
          '  - path: [../shared/cache.yaml, ../shared/queue.yaml]',
          '    env_file: [../shared/.env]',
          '    project_directory: ../shared',
          'x-inc: &inc {path: ../shared/more.yaml}',
          '<<: {include: [*inc]}',
          'services: {}',
          '',
        ].join('\n'),
        'shared/db.yaml': 'services:\n  db:\n    extends: {file: base.yaml, service: db}\n',
        'shared/base.yaml': 'services:\n  db:\n    image: postgres:18-alpine\n',
        'shared/cache.yaml': 'include: [nested/x.yaml]\n',
        'shared/nested/x.yaml': '',
        'shared/queue.yaml': '',
        'shared/more.yaml': '',
        'shared/.env': 'A=1\n',
      });
      await expect(preflight('deploy')).resolves.toBeUndefined();
    });

    it.each<[string, string, RegExp]>([
      [
        'an absolute path',
        'include: [/etc/compose.yaml]\n',
        /include "\/etc\/compose\.yaml" must be a relative/,
      ],
      [
        'a path out of the repository',
        'include: [../../outside/compose.yaml]\n',
        /leaves the repository/,
      ],
      [
        'a symlink out of the repository',
        'include: [escape/compose.yaml]\n',
        /leaves the repository/,
      ],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, kept literally
      ['a variable', 'include: ["${X:-../x}.yaml"]\n', /must not use variables/],
      ['an OCI include', 'include: ["oci://docker.io/acme/stack:1"]\n', /is remote/],
      ['a git include', 'include: ["git@github.com:acme/stack.git"]\n', /is remote/],
      [
        'an HTTPS git include',
        'include: ["https://github.com/acme/stack.git#main"]\n',
        /is remote/,
      ],
      [
        'an env file out of the repository',
        'include:\n  - path: ok.yaml\n    env_file: ../../outside/secrets.env\n',
        /include env_file "\.\.\/\.\.\/outside\/secrets\.env" leaves the repository/,
      ],
      [
        'an absolute env file (another deployment)',
        'include:\n  - path: ok.yaml\n    env_file: /var/lib/launchway/apps/app_1/dep_1/.env\n',
        /include env_file ".*" must be a relative path/,
      ],
      [
        'a project directory out of the repository',
        'include:\n  - path: ok.yaml\n    project_directory: ../../outside\n',
        /include project_directory "\.\.\/\.\.\/outside" leaves the repository/,
      ],
      [
        'an include merged at the top level',
        'x-i: &i\n  include: [../../outside/compose.yaml]\n<<: *i\n',
        /leaves the repository/,
      ],
      [
        'an include behind an alias',
        'x-i: &i [{path: ../../outside/compose.yaml}]\ninclude: *i\n',
        /leaves the repository/,
      ],
      [
        'an unknown include key',
        'include:\n  - path: ok.yaml\n    profiles: [x]\n',
        /include entries may only set path, env_file, project_directory \(not "profiles"\)/,
      ],
      ['an include that is no list', 'include: ok.yaml\n', /include must be a list/],
    ])('refuses %s', async (_label, compose, pattern) => {
      await repo({ '.devcontainer/compose.yaml': compose, '.devcontainer/ok.yaml': '' });
      await symlink(outside, join(root, '.devcontainer', 'escape'));
      const result = preflight('deploy');
      await expect(result).rejects.toThrow(PolicyError);
      await expect(result).rejects.toThrow(pattern);
    });

    it('checks included files in turn, also against their project directory', async () => {
      await repo({
        '.devcontainer/compose.yaml':
          'include:\n  - path: ../a/compose.yaml\n    project_directory: ../a/b\n',
        'a/compose.yaml': 'include:\n  - path: ../../../outside/compose.yaml\n',
        'a/b/.keep': '',
      });
      await expect(preflight('deploy')).rejects.toThrow(
        /^a\/compose\.yaml: include path ".*" leaves the repository$/,
      );
    });
  });

  describe.each(['check', 'deploy'] as const)('YAML it cannot trust (%s)', (mode) => {
    it.each<[string, string, typeof PolicyError, RegExp]>([
      ['invalid YAML', 'services: [\n', ComposeFileError, /is not valid YAML/],
      ['duplicate keys', 'services: {}\nservices: {}\n', ComposeFileError, /is not valid YAML/],
      ['a list at the top', '- a\n', ComposeFileError, /the top level is not a mapping/],
      [
        'services that are no mapping',
        'services: [dev]\n',
        ComposeFileError,
        /services must be a mapping/,
      ],
      [
        'a binary key',
        '!!binary aW5jbHVkZQ==: [x.yaml]\n',
        PolicyError,
        /the YAML tag tag:yaml\.org,2002:binary is not allowed/,
      ],
      [
        'a binary tag through a %TAG directive',
        '%TAG !x! tag:yaml.org,2002:\n---\n!x!binary aW5jbHVkZQ==: [x.yaml]\n',
        PolicyError,
        /the YAML tag tag:yaml\.org,2002:binary is not allowed/,
      ],
      [
        'a custom tag',
        'services: !custom {}\n',
        PolicyError,
        /the YAML tag !custom is not allowed/,
      ],
      ['a collection as key', '? [a, b]\n: x\n', PolicyError, /mapping keys must be plain names/],
      [
        'an alias to a missing anchor',
        'services: *nope\n',
        ComposeFileError,
        /names an anchor that does not exist/,
      ],
    ])('refuses %s', async (_label, compose, type, pattern) => {
      await repo({ '.devcontainer/compose.yaml': compose });
      const result = preflight(mode);
      await expect(result).rejects.toThrow(type);
      await expect(result).rejects.toThrow(pattern);
    });

    it('refuses aliases that expand without bound', async () => {
      const lines = ['x-m0: &m0 {a: 1}'];
      for (let i = 1; i <= 6; i += 1) {
        lines.push(
          `x-m${i}: &m${i} {<<: [${Array(10)
            .fill(`*m${i - 1}`)
            .join(', ')}]}`,
        );
      }
      lines.push('services:', '  dev:', '    <<: *m6');
      await repo({ '.devcontainer/compose.yaml': `${lines.join('\n')}\n` });
      await expect(preflight(mode)).rejects.toThrow(/YAML aliases expand to too many nodes/);
    });

    it('refuses files over 4 MiB', async () => {
      await repo({ '.devcontainer/compose.yaml': `# ${'x'.repeat(4 * 1024 * 1024)}\n` });
      await expect(preflight(mode)).rejects.toThrow(/is larger than 4 MiB/);
    });
  });
});
