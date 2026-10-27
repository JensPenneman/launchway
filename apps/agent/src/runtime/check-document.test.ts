import { CHECK_ENV_KEYS, generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildCheckDocument,
  type CheckDocumentInput,
  checkEnvironment,
  checkSourcePaths,
  type SourcePath,
} from './check-document.js';
import type { ComposeConfig } from './compose-policy.js';
import { PolicyError } from './workspace.js';

const ROOT = '/ws/checks/app_1/chk_1/src';
const DEVC = `${ROOT}/.devcontainer`;
const runId = generateId('chk');
const project = `launchway-check_trail_${runId.slice(4)}`;
const LIMITS = { memoryBytes: 4 * 1024 ** 3, cpus: 2, pidsLimit: 4096 };

/** `docker compose config --format json` of a Trail-like dev container (strings escaped). */
function trailConfig(): ComposeConfig {
  return structuredClone({
    name: project,
    services: {
      dev: {
        build: {
          context: ROOT,
          dockerfile: '.devcontainer/Dockerfile',
          args: { USER_UID: '1000', HTTPS_PROXY: null },
          tags: ['ghcr.io/acme/trail:latest'],
          cache_from: ['type=local,src=/var/lib/launchway', 'ghcr.io/acme/trail:cache'],
          cache_to: ['type=registry,ref=ghcr.io/acme/trail:cache'],
          labels: { 'org.example': 'x' },
          secrets: [{ source: 'npmrc' }],
        },
        image: 'ghcr.io/acme/trail:dev',
        init: true,
        command: ['sleep', 'infinity'],
        environment: {
          DATABASE_URL: 'postgres://db/trail',
          PRICE: '$$5',
          CI: 'false',
          EMPTY: null,
        },
        labels: { 'org.example.role': 'dev' },
        ports: [{ mode: 'ingress', target: 5173, published: '5173', protocol: 'tcp' }],
        container_name: 'trail-dev',
        restart: 'unless-stopped',
        logging: { driver: 'syslog', options: { 'syslog-address': 'udp://10.0.0.1:514' } },
        develop: { watch: [{ action: 'sync', path: ROOT, target: '/w' }] },
        deploy: { resources: { limits: { memory: '536870912' } }, replicas: 3 },
        scale: 2,
        cpu_shares: 262144,
        oom_kill_disable: true,
        oom_score_adj: -1000,
        pids_limit: -1,
        ulimits: { nofile: { soft: 900000, hard: 900000 } },
        cpuset: '0-1',
        storage_opt: { size: '1G' },
        security_opt: ['no-new-privileges'],
        user: 'node',
        volumes: [
          { type: 'bind', source: ROOT, target: '/workspaces/trail', bind: {} },
          {
            type: 'volume',
            source: 'node-modules',
            target: '/workspaces/trail/node_modules',
            volume: {},
          },
          { type: 'bind', source: `${ROOT}/docs`, target: '/docs', read_only: true, bind: {} },
          { type: 'bind', source: `${DEVC}/cache`, target: '/cache', bind: {} },
          { type: 'bind', source: `${ROOT}/big.json`, target: '/data/big.json', read_only: true },
          { type: 'bind', source: `${ROOT}/notes.txt`, target: '/notes.txt' },
          { type: 'bind', source: `${ROOT}/logo.png`, target: '/logo.png', read_only: true },
          { type: 'tmpfs', target: '/tmp' },
        ],
        configs: [{ source: 'app', target: '/etc/app.conf' }],
        secrets: [
          { source: 'token', target: '/run/secrets/token' },
          { source: 'token', target: 'other' },
          { source: 'key', target: '/etc/key.pem' },
          { source: 'fromenv', target: '/run/secrets/fromenv' },
        ],
        depends_on: { db: { condition: 'service_healthy', required: true } },
        networks: { default: null },
        pull_policy: 'always',
      },
      db: {
        image: 'postgres:18-alpine',
        mem_limit: '1073741824',
        pull_policy: 'never',
        environment: { PROXY: null },
        networks: { default: null },
        volumes: [
          { type: 'volume', source: 'db', target: '/var/lib/postgresql', volume: {} },
          {
            type: 'bind',
            source: `${ROOT}/scripts/db/init-dev.sql`,
            target: '/docker-entrypoint-initdb.d/10-databases.sql',
            read_only: true,
            bind: {},
          },
        ],
      },
    },
    networks: { default: { name: `${project}_default`, ipam: {} } },
    volumes: {
      db: { name: `${project}_db` },
      'node-modules': { name: `${project}_node-modules`, labels: { 'org.example': 'keep' } },
      empty: null,
    },
    configs: {
      app: { name: `${project}_app`, file: `${ROOT}/config/app.conf` },
      inline: { name: `${project}_inline`, content: 'x $$y' },
    },
    secrets: {
      token: { name: `${project}_token`, file: `${ROOT}/secrets/token.txt` },
      key: { name: `${project}_key`, file: `${ROOT}/secrets/key.pem` },
      npmrc: { name: `${project}_npmrc`, file: `${ROOT}/.npmrc` },
      fromenv: { name: `${project}_fromenv`, environment: 'HOME' },
    },
  }) as unknown as ComposeConfig;
}

const SOURCES: Record<string, SourcePath> = {
  [ROOT]: { kind: 'directory', relative: '' },
  [`${ROOT}/docs`]: { kind: 'directory', relative: 'docs' },
  [`${DEVC}/cache`]: { kind: 'missing', relative: '.devcontainer/cache' },
  [`${ROOT}/big.json`]: { kind: 'file', relative: 'big.json', size: 70_000 },
  [`${ROOT}/notes.txt`]: { kind: 'file', relative: 'notes.txt', size: 5, content: 'notes' },
  [`${ROOT}/logo.png`]: { kind: 'file', relative: 'logo.png', size: 300 },
  [`${ROOT}/scripts/db/init-dev.sql`]: {
    kind: 'file',
    relative: 'scripts/db/init-dev.sql',
    size: 40,
    content: 'CREATE DATABASE trail_test; -- $1 $$\n',
  },
  [`${ROOT}/config/app.conf`]: {
    kind: 'file',
    relative: 'config/app.conf',
    size: 12,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose variable, kept literally
    content: 'port=${PORT}',
  },
  [`${ROOT}/secrets/token.txt`]: {
    kind: 'file',
    relative: 'secrets/token.txt',
    size: 6,
    content: 'abc$de',
  },
  [`${ROOT}/secrets/key.pem`]: {
    kind: 'file',
    relative: 'secrets/key.pem',
    size: 3,
    content: 'KEY',
  },
  [`${ROOT}/.npmrc`]: { kind: 'file', relative: '.npmrc', size: 3, content: 'x=1' },
};

function input(overrides: Partial<CheckDocumentInput> = {}): CheckDocumentInput {
  return {
    project,
    slug: 'trail',
    runId,
    service: 'dev',
    env: checkEnvironment(
      {
        runId,
        app: { id: generateId('app'), slug: 'trail' },
        source: {
          cloneUrl: 'https://github.com/acme/trail.git',
          ref: 'feature/x',
          sha: 'a'.repeat(40),
          authorization: null,
        },
      },
      project,
    ),
    limits: LIMITS,
    projectDir: DEVC,
    sources: (path) => SOURCES[path],
    ...overrides,
  };
}

type Service = Record<string, unknown> & {
  volumes: Record<string, unknown>[];
  configs?: Record<string, unknown>[];
  secrets?: Record<string, unknown>[];
  build?: Record<string, unknown>;
  environment: Record<string, unknown>;
};

function build(overrides: Partial<CheckDocumentInput> = {}, config = trailConfig()) {
  const result = buildCheckDocument(config, input(overrides));
  const doc = result.document as {
    name: string;
    services: Record<string, Service>;
    volumes: Record<string, Record<string, unknown>>;
    networks: Record<string, Record<string, unknown>>;
    configs: Record<string, Record<string, unknown>>;
    secrets?: Record<string, Record<string, unknown>>;
  };
  const dev = doc.services.dev;
  const db = doc.services.db;
  if (!dev || !db) throw new Error('services missing');
  return { result, doc, dev, db };
}

describe('checkEnvironment', () => {
  it('sets exactly the check variables', () => {
    const env = input().env;
    expect(Object.keys(env).sort()).toEqual([...CHECK_ENV_KEYS].sort());
    expect(env).toEqual({
      CI: 'true',
      COMPOSE_PROJECT_NAME: project,
      LAUNCHWAY_APP: 'trail',
      LAUNCHWAY_CHECK: '1',
      LAUNCHWAY_CHECK_RUN_ID: runId,
      LAUNCHWAY_COMMIT_SHA: 'a'.repeat(40),
      LAUNCHWAY_REF: 'feature/x',
    });
  });
});

describe('checkSourcePaths', () => {
  it('lists bind sources and config and secret files, unescaped and absolute', () => {
    const config = trailConfig();
    const db = config.services.db as unknown as { volumes: Record<string, unknown>[] };
    db.volumes.push({ type: 'bind', source: './price$$list', target: '/p' });
    expect(checkSourcePaths(config, DEVC).sort()).toEqual(
      [
        ROOT,
        `${ROOT}/docs`,
        `${DEVC}/cache`,
        `${ROOT}/big.json`,
        `${ROOT}/notes.txt`,
        `${ROOT}/logo.png`,
        `${ROOT}/scripts/db/init-dev.sql`,
        `${DEVC}/price$list`,
        `${ROOT}/config/app.conf`,
        `${ROOT}/secrets/token.txt`,
        `${ROOT}/secrets/key.pem`,
        `${ROOT}/.npmrc`,
      ].sort(),
    );
  });
});

describe('buildCheckDocument', () => {
  it('names the project and reports the image, user, source use and new directories', () => {
    const { result, doc } = build();
    expect(doc.name).toBe(project);
    expect(result.image).toBe('launchway-check/trail-dev');
    expect(result.user).toBe('node');
    expect(result.usesSource).toBe(true);
    expect(result.directories).toEqual(['.devcontainer/cache']);
    expect(result.notes).toContain(
      'service "db": "scripts/db/init-dev.sql" is passed as a file at /docker-entrypoint-initdb.d/10-databases.sql',
    );
    expect(result.notes).toContain(
      'service "dev": the repository is mounted from the source volume at /workspaces/trail',
    );
  });

  it('turns directory binds into source volume mounts, with the repository path as subpath', () => {
    const { dev, doc } = build();
    const mounts = dev.volumes.filter((v) => v.source === 'launchway-check-source');
    expect(mounts).toEqual([
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/workspaces/trail',
        volume: { nocopy: true },
      },
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/docs',
        read_only: true,
        volume: { nocopy: true, subpath: 'docs' },
      },
      // Missing: created as a directory before the copy, like Docker does for a bind.
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/cache',
        volume: { nocopy: true, subpath: '.devcontainer/cache' },
      },
      // Too big to inline.
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/data/big.json',
        read_only: true,
        volume: { nocopy: true, subpath: 'big.json' },
      },
      // Writable: a config would be a read-only copy.
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/notes.txt',
        volume: { nocopy: true, subpath: 'notes.txt' },
      },
      // Binary: not inlined.
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/logo.png',
        read_only: true,
        volume: { nocopy: true, subpath: 'logo.png' },
      },
    ]);
    expect(
      dev.volumes.filter((v) => v.type !== 'volume' || v.source !== 'launchway-check-source'),
    ).toEqual([
      {
        type: 'volume',
        source: 'node-modules',
        target: '/workspaces/trail/node_modules',
        volume: {},
      },
      { type: 'tmpfs', target: '/tmp' },
    ]);
    expect(JSON.stringify(doc)).not.toContain('"bind"');
    expect(doc.volumes['launchway-check-source']).toEqual({
      name: `${project}_source`,
      external: true,
    });
  });

  it('passes small read-only files as inline configs with `$` escaped, without a mode', () => {
    const { db, doc } = build();
    expect(db.volumes).toEqual([
      { type: 'volume', source: 'db', target: '/var/lib/postgresql', volume: {} },
    ]);
    // Numbered in service order: dev's secrets took 1 and 2.
    expect(db.configs).toEqual([
      { source: 'launchway-check-file-3', target: '/docker-entrypoint-initdb.d/10-databases.sql' },
    ]);
    expect(doc.configs['launchway-check-file-3']).toEqual({
      content: 'CREATE DATABASE trail_test; -- $$1 $$$$\n',
    });
  });

  it('inlines file-based configs and the secrets services use; build secrets stay files', () => {
    const { dev, doc } = build();
    expect(doc.configs.app).toEqual({ name: `${project}_app`, content: 'port=$${PORT}' });
    expect(doc.configs.inline).toEqual({ name: `${project}_inline`, content: 'x $$y' });
    expect(dev.configs).toEqual([
      { source: 'app', target: '/etc/app.conf' },
      { source: 'launchway-check-file-1', target: '/run/secrets/token' },
      { source: 'launchway-check-file-1', target: '/run/secrets/other' },
      { source: 'launchway-check-file-2', target: '/etc/key.pem' },
    ]);
    expect(doc.configs['launchway-check-file-1']).toEqual({ content: 'abc$$de' });
    expect(doc.configs['launchway-check-file-2']).toEqual({ content: 'KEY' });
    // Environment-based secrets are no file: they stay secrets.
    expect(dev.secrets).toEqual([{ source: 'fromenv', target: '/run/secrets/fromenv' }]);
    expect(doc.secrets).toEqual({
      npmrc: { name: `${project}_npmrc`, file: `${ROOT}/.npmrc` },
      fromenv: { name: `${project}_fromenv`, environment: 'HOME' },
    });
  });

  it('replaces resource settings with the check limits on every service', () => {
    const { dev, db } = build();
    for (const service of [dev, db]) {
      expect(service).toMatchObject({
        mem_limit: LIMITS.memoryBytes,
        memswap_limit: LIMITS.memoryBytes,
        cpus: 2,
        pids_limit: 4096,
        oom_score_adj: 1000,
        security_opt: ['no-new-privileges:true'],
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      });
      for (const key of [
        'ports',
        'container_name',
        'deploy',
        'scale',
        'restart',
        'develop',
        'cpu_shares',
        'oom_kill_disable',
        'ulimits',
        'cpuset',
        'storage_opt',
      ]) {
        expect(service).not.toHaveProperty(key);
      }
    }
    expect(dev.init).toBe(true);
    expect(dev.depends_on).toEqual({ db: { condition: 'service_healthy', required: true } });
  });

  it('takes network addresses from the daemon, not from the repository', () => {
    const config = {
      name: project,
      services: {
        dev: {
          image: 'alpine:3',
          networks: {
            default: null,
            tools: { ipv4_address: '198.51.100.10', ipv6_address: 'fd00::10', aliases: ['t'] },
            only: { ipv4_address: '198.51.100.11', link_local_ips: ['169.254.1.1'] },
          },
        },
      },
      networks: {
        default: { name: `${project}_default`, ipam: {} },
        tools: {
          name: `${project}_tools`,
          ipam: { config: [{ subnet: '198.51.100.0/24', gateway: '198.51.100.1' }] },
          enable_ipv6: true,
          internal: true,
        },
        only: { name: `${project}_only`, enable_ipv4: false, enable_ipv6: true },
      },
    } as unknown as ComposeConfig;
    const { document } = buildCheckDocument(config, { ...input(), service: 'dev' });
    const doc = document as {
      services: Record<string, { networks: Record<string, unknown> }>;
      networks: Record<string, unknown>;
    };
    expect(doc.networks).toEqual({
      default: { name: `${project}_default`, labels: { 'launchway.check': runId } },
      tools: { name: `${project}_tools`, internal: true, labels: { 'launchway.check': runId } },
      only: { name: `${project}_only`, labels: { 'launchway.check': runId } },
    });
    expect(doc.services.dev?.networks).toEqual({
      default: null,
      tools: { aliases: ['t'] },
      only: null,
    });
  });

  it('labels services, volumes and networks with the run', () => {
    const { dev, db, doc } = build();
    expect(dev.labels).toEqual({ 'org.example.role': 'dev', 'launchway.check': runId });
    expect(db.labels).toEqual({ 'launchway.check': runId });
    expect(doc.networks.default).toEqual({
      name: `${project}_default`,
      labels: { 'launchway.check': runId },
    });
    expect(doc.volumes.db).toEqual({ name: `${project}_db`, labels: { 'launchway.check': runId } });
    expect(doc.volumes['node-modules']?.labels).toEqual({
      'org.example': 'keep',
      'launchway.check': runId,
    });
    expect(doc.volumes.empty).toEqual({ labels: { 'launchway.check': runId } });
  });

  it('tags built images per app and service and never retags, exports or pulls them', () => {
    const { dev, db } = build();
    expect(dev.image).toBe('launchway-check/trail-dev');
    expect(dev.pull_policy).toBe('never');
    expect(dev.build).toEqual({
      context: ROOT,
      dockerfile: '.devcontainer/Dockerfile',
      args: { USER_UID: '1000' },
      cache_from: ['ghcr.io/acme/trail:cache'],
      labels: { 'org.example': 'x', 'launchway.check': 'trail' },
      secrets: [{ source: 'npmrc' }],
    });
    expect(db.image).toBe('postgres:18-alpine');
    expect(db).not.toHaveProperty('pull_policy');
  });

  it("pulls every image the repository names and fills in nothing from the CLI's environment", () => {
    const { dev, db } = build();
    // Built: never pulled; not built: pull_policy dropped (the run pulls with --policy always).
    expect(dev.pull_policy).toBe('never');
    expect(db).not.toHaveProperty('pull_policy');
    // Valueless entries would be filled in from the Compose CLI's environment.
    expect(dev.build?.args).toEqual({ USER_UID: '1000' });
    expect(dev.environment).not.toHaveProperty('EMPTY');
    expect(db).not.toHaveProperty('environment');
  });

  it('gives the check service the check variables, escaped, over its own', () => {
    const env = { ...input().env, LAUNCHWAY_REF: 'a$b' };
    const { dev, db } = build({ env });
    expect(dev.environment).toEqual({
      DATABASE_URL: 'postgres://db/trail',
      PRICE: '$$5',
      CI: 'true',
      COMPOSE_PROJECT_NAME: project,
      LAUNCHWAY_APP: 'trail',
      LAUNCHWAY_CHECK: '1',
      LAUNCHWAY_CHECK_RUN_ID: runId,
      LAUNCHWAY_COMMIT_SHA: 'a'.repeat(40),
      LAUNCHWAY_REF: 'a$$b',
    });
    expect(db).not.toHaveProperty('environment');
  });

  it('runs the check in a service that is not built, with its own image', () => {
    const { result, db } = build({ service: 'db' });
    expect(result.image).toBe('postgres:18-alpine');
    expect(result.user).toBeNull();
    expect(db.environment).toMatchObject({ LAUNCHWAY_CHECK: '1' });
  });

  it('declares no source volume when no service binds the repository', () => {
    const config = {
      name: project,
      services: { dev: { image: 'alpine:3', command: ['true'] } },
    } as unknown as ComposeConfig;
    const result = buildCheckDocument(config, input());
    expect(result.usesSource).toBe(false);
    expect(result.document).toEqual({
      name: project,
      services: {
        dev: {
          image: 'alpine:3',
          command: ['true'],
          labels: { 'launchway.check': runId },
          mem_limit: LIMITS.memoryBytes,
          memswap_limit: LIMITS.memoryBytes,
          cpus: 2,
          pids_limit: 4096,
          oom_score_adj: 1000,
          logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
          security_opt: ['no-new-privileges:true'],
          environment: input().env,
        },
      },
    });
  });

  it('escapes `$` in repository paths used as subpaths', () => {
    const config = {
      services: {
        dev: { image: 'x', volumes: [{ type: 'bind', source: `${ROOT}/a$$b`, target: '/a$$b' }] },
      },
    } as unknown as ComposeConfig;
    const result = buildCheckDocument(
      config,
      input({
        sources: (path) =>
          path === `${ROOT}/a$b` ? { kind: 'directory', relative: 'a$b' } : undefined,
      }),
    );
    const dev = (result.document.services as Record<string, Service>).dev;
    expect(dev?.volumes).toEqual([
      {
        type: 'volume',
        source: 'launchway-check-source',
        target: '/a$$b',
        volume: { nocopy: true, subpath: 'a$$b' },
      },
    ]);
    expect(result.notes).toEqual([
      'service "dev": "a$b" is mounted from the source volume at /a$b',
    ]);
  });

  it.each<[string, Partial<CheckDocumentInput>, ComposeConfig | undefined, RegExp]>([
    ['a missing check service', { service: 'web' }, undefined, /"web" of the check does not exist/],
    [
      'a bind the probe did not find inside the checkout',
      { sources: (path) => (path === ROOT ? undefined : SOURCES[path]) },
      undefined,
      /bind mount ".*" is not a file or directory inside the repository/,
    ],
    [
      'a secret that is not a text file',
      {
        sources: (path) =>
          path === `${ROOT}/secrets/key.pem`
            ? { kind: 'file', relative: 'secrets/key.pem', size: 10 }
            : SOURCES[path],
      },
      undefined,
      /secret "key": "secrets\/key.pem" cannot be passed to a check/,
    ],
    [
      'a service without an image',
      {},
      { services: { dev: { command: ['true'] } } } as unknown as ComposeConfig,
      /has no image/,
    ],
  ])('refuses %s', (_label, overrides, config, pattern) => {
    expect(() => buildCheckDocument(config ?? trailConfig(), input(overrides))).toThrow(
      PolicyError,
    );
    expect(() => buildCheckDocument(config ?? trailConfig(), input(overrides))).toThrow(pattern);
  });

  it('leaves the input untouched', () => {
    const config = trailConfig();
    const before = JSON.stringify(config);
    buildCheckDocument(config, input());
    expect(JSON.stringify(config)).toBe(before);
  });
});
