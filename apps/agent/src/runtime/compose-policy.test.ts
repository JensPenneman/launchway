import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployPolicy, DeployRoute } from '@launchway/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ComposeConfig,
  evaluateComposePolicy,
  MAX_INLINE_FILE_BYTES,
  type PolicyContext,
  parseComposeConfig,
} from './compose-policy.js';
import { isInsideReal } from './workspace.js';

const WORKSPACE = '/ws';
const CHECKOUT = '/ws/apps/app_1/dep_1';
const fixture = readFileSync(new URL('./fixtures/mailserver.config.json', import.meta.url), 'utf8');
const trailFixture = readFileSync(new URL('./fixtures/trail.config.json', import.meta.url), 'utf8');

function context(routes: DeployRoute[] = [], mountPolicy?: DeployPolicy): PolicyContext {
  return {
    projectName: 'launchway-mail',
    proxyNetwork: 'launchway-proxy',
    routes,
    isInsideCheckout: (path) => path === CHECKOUT || path.startsWith(`${CHECKOUT}/`),
    projectDir: CHECKOUT,
    workspaceRoot: WORKSPACE,
    mountPolicy,
  };
}

function base(): ComposeConfig {
  const config = parseComposeConfig(fixture);
  if (!config) throw new Error('fixture did not parse');
  return config;
}

/** The fixture with one service replaced/extended. */
function withService(name: string, service: Record<string, unknown>): ComposeConfig {
  const config = base();
  return { ...config, services: { ...config.services, [name]: service } } as ComposeConfig;
}

function violations(config: ComposeConfig, routes: DeployRoute[] = []): string[] {
  return evaluateComposePolicy(config, context(routes)).violations;
}

describe('evaluateComposePolicy', () => {
  it('allows a realistic project and reports its published ports', () => {
    const result = evaluateComposePolicy(
      base(),
      context([{ service: 'web', port: 8080, alias: 'mail-web' }]),
    );
    expect(result.violations).toEqual([]);
    expect(result.ports).toEqual([
      { service: 'mail', containerPort: '25', hostPort: '25', hostIp: null, protocol: 'tcp' },
      {
        service: 'mail',
        containerPort: '993',
        hostPort: '993',
        hostIp: '0.0.0.0',
        protocol: 'tcp',
      },
      { service: 'web', containerPort: '8080', hostPort: null, hostIp: null, protocol: 'tcp' },
    ]);
  });

  it('allows reserved names for services that are not routed', () => {
    expect(violations(base())).toEqual([]);
    expect(Object.keys(base().services)).toContain('db');
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      'host bind mounts',
      { image: 'x', volumes: [{ type: 'bind', source: '/etc', target: '/etc' }] },
      /host bind mount "\/etc"/,
    ],
    [
      'bind mounts inside the checkout',
      { image: 'x', volumes: [{ type: 'bind', source: `${CHECKOUT}/data`, target: '/d' }] },
      /bind mount/,
    ],
    [
      'npipe mounts',
      { image: 'x', volumes: [{ type: 'npipe', source: 'x', target: 'y' }] },
      /mount type npipe/,
    ],
    ['privileged', { image: 'x', privileged: true }, /privileged is not allowed/],
    ['network_mode host', { image: 'x', network_mode: 'host' }, /network_mode host/],
    [
      'network_mode container:',
      { image: 'x', network_mode: 'container:caddy' },
      /network_mode container:caddy/,
    ],
    [
      'network_mode naming the proxy network',
      { image: 'x', network_mode: 'launchway-proxy' },
      /network_mode launchway-proxy/,
    ],
    [
      'network_mode naming another network',
      { image: 'x', network_mode: 'launchway-other_default' },
      /network_mode launchway-other_default/,
    ],
    [
      'network_mode of a service in another project',
      { image: 'x', network_mode: 'service:nope' },
      /network_mode service:nope/,
    ],
    ['pid of another container', { image: 'x', pid: 'container:caddy' }, /pid container:caddy/],
    ['device cgroup rules', { image: 'x', device_cgroup_rules: ['b *:* rwm'] }, /device_cgroup/],
    ['cgroup_parent', { image: 'x', cgroup_parent: '/' }, /cgroup_parent/],
    ['a custom runtime', { image: 'x', runtime: 'runc-custom' }, /runtime/],
    ['gpus', { image: 'x', gpus: 'all' }, /gpus/],
    [
      'device reservations',
      { image: 'x', deploy: { resources: { reservations: { devices: [{ count: 1 }] } } } },
      /device reservations/,
    ],
    [
      'a custom seccomp profile',
      { image: 'x', security_opt: ['seccomp=./allow-all.json'] },
      /security_opt seccomp/,
    ],
    [
      'oci-layout build contexts',
      { build: { context: CHECKOUT, additional_contexts: { x: 'oci-layout:///var/lib/x' } } },
      /additional_contexts/,
    ],
    ['pid host', { image: 'x', pid: 'host' }, /pid host/],
    ['ipc host', { image: 'x', ipc: 'host' }, /ipc host/],
    ['userns_mode host', { image: 'x', userns_mode: 'host' }, /userns_mode host/],
    ['extra capabilities', { image: 'x', cap_add: ['NET_ADMIN'] }, /cap_add NET_ADMIN/],
    ['cap_add ALL', { image: 'x', cap_add: ['ALL'] }, /cap_add ALL/],
    ['unconfined seccomp', { image: 'x', security_opt: ['seccomp=unconfined'] }, /security_opt/],
    ['devices', { image: 'x', devices: [{ source: '/dev/sda', target: '/dev/sda' }] }, /devices/],
    [
      'volumes_from another container',
      { image: 'x', volumes_from: ['container:launchway-agent'] },
      /volumes_from/,
    ],
    ['use_api_socket', { image: 'x', use_api_socket: true }, /use_api_socket/],
    ['provider services', { provider: { type: 'model' } }, /provider/],
    ['reserved container names', { image: 'x', container_name: 'caddy' }, /container_name "caddy"/],
    [
      'joining the proxy network',
      { image: 'x', networks: { 'launchway-proxy': null } },
      /proxy network/,
    ],
    [
      'env files outside the checkout',
      { image: 'x', env_file: [{ path: '/var/lib/launchway/agent/credentials.json' }] },
      /env_file.*outside/,
    ],
    ['label files outside the checkout', { image: 'x', label_file: ['/etc/passwd'] }, /label_file/],
    ['build contexts outside the checkout', { build: { context: '/ws/apps' } }, /build context/],
    [
      'dockerfiles outside the checkout',
      { build: { context: CHECKOUT, dockerfile: '../../other/Dockerfile' } },
      /dockerfile/,
    ],
    [
      'additional contexts outside the checkout',
      { build: { context: CHECKOUT, additional_contexts: { x: '/' } } },
      /additional_contexts/,
    ],
    [
      'host networking during builds',
      { build: { context: CHECKOUT, network: 'host' } },
      /build network host/,
    ],
    [
      'build entitlements',
      { build: { context: CHECKOUT, entitlements: ['security.insecure'] } },
      /entitlements/,
    ],
  ])('rejects %s', (_label, service, pattern) => {
    const found = violations(withService('bad', service));
    expect(found.join('\n')).toMatch(pattern);
  });

  it.each<[string, Partial<ComposeConfig>, RegExp]>([
    [
      'external volumes',
      { volumes: { data: { external: true, name: 'launchway_pgdata' } } },
      /external volumes/,
    ],
    [
      'custom volume names',
      { volumes: { data: { name: 'launchway-other_data' } } },
      /custom volume name/,
    ],
    [
      'volumes bound to host paths',
      {
        volumes: {
          data: {
            name: 'launchway-mail_data',
            driver_opts: { type: 'none', o: 'bind', device: '/' },
          },
        },
      },
      /host paths/,
    ],
    [
      'overlay volumes over host paths',
      {
        volumes: {
          v: {
            name: 'launchway-mail_v',
            driver_opts: { type: 'overlay', device: 'overlay', o: 'lowerdir=/etc:/root' },
          },
        },
      },
      /host paths/,
    ],
    [
      'lowerdir options on an allowed type',
      { volumes: { v: { driver_opts: { type: 'nfs', device: ':/x', o: 'lowerdir=/etc' } } } },
      /host paths/,
    ],
    ['volume plugins', { volumes: { v: { driver: 'local-persist' } } }, /volume driver/],
    [
      'reusing another project network by name',
      { networks: { n: { name: 'launchway-other_default' } } },
      /custom network name/,
    ],
    [
      'macvlan networks',
      {
        networks: {
          n: { name: 'launchway-mail_n', driver: 'macvlan', driver_opts: { parent: 'eth0' } },
        },
      },
      /network driver "macvlan"[\s\S]*driver_opts/,
    ],
    [
      'a declared proxy network',
      { networks: { edge: { name: 'launchway-proxy', external: true } } },
      /proxy network/,
    ],
    [
      'the default proxy network under another key',
      { networks: { 'launchway-proxy': { name: 'x' } } },
      /proxy network/,
    ],
    [
      'external networks',
      { networks: { other: { name: 'launchway-other_default', external: true } } },
      /external networks/,
    ],
    ['the host network', { networks: { h: { name: 'host', external: true } } }, /host networking/],
    [
      'config files outside the checkout',
      { configs: { c: { file: '/etc/shadow' } } },
      /config "c".*outside/,
    ],
    [
      'secret files outside the checkout',
      { secrets: { s: { file: '/var/lib/launchway/agent/credentials.json' } } },
      /secret "s".*outside/,
    ],
  ])('rejects %s', (_label, patch, pattern) => {
    const config = { ...base(), ...patch } as ComposeConfig;
    expect(violations(config).join('\n')).toMatch(pattern);
  });

  it('rejects routes to missing services, network_mode services and reserved names', () => {
    expect(violations(base(), [{ service: 'nope', port: 80, alias: 'mail-nope' }]).join()).toMatch(
      /does not exist/,
    );
    expect(
      violations(base(), [{ service: 'worker', port: 80, alias: 'mail-worker' }]).join(),
    ).toMatch(/cannot use network_mode/);
    expect(violations(base(), [{ service: 'db', port: 5432, alias: 'mail-db' }]).join()).toMatch(
      /reserved/,
    );
  });

  it('checks attach-only services like routed ones', () => {
    const check = (service: string) =>
      evaluateComposePolicy(base(), {
        ...context(),
        attach: [{ service, alias: `mail-${service}` }],
      }).violations.join();
    expect(check('web')).toBe('');
    expect(check('nope')).toMatch(/attached service "nope": the service does not exist/);
    expect(check('worker')).toMatch(/cannot use network_mode/);
    expect(check('db')).toMatch(/reserved/);
  });

  it('allows own-service namespaces, none and no-new-privileges', () => {
    const config = withService('side', {
      image: 'x',
      network_mode: 'service:web',
      pid: 'service:web',
      ipc: 'shareable',
      security_opt: ['no-new-privileges:true'],
    });
    expect(violations(config)).toEqual([]);
    expect(violations(withService('iso', { image: 'x', network_mode: 'none' }))).toEqual([]);
  });

  it('honours a custom proxy network name', () => {
    const config = { ...base(), networks: { edge: { name: 'my-proxy' } } } as ComposeConfig;
    expect(
      evaluateComposePolicy(config, { ...context(), proxyNetwork: 'my-proxy' }).violations.join(),
    ).toMatch(/proxy network/);
  });

  it('refuses output it cannot understand', () => {
    expect(parseComposeConfig('not json')).toBeNull();
    expect(parseComposeConfig('{"services": {"a": {"privileged": "yes"}}}')).toBeNull();
    expect(parseComposeConfig('{}')).toBeNull();
  });
});

describe('evaluateComposePolicy and the image namespace of checks', () => {
  it.each([
    ['an image', { image: 'launchway-check/trail-dev' }],
    ['a Docker Hub spelling of it', { image: 'docker.io/launchway-check/trail-dev:latest' }],
    ['a capitalised spelling', { image: 'Launchway-Check/other-dev' }],
    [
      'a build tag',
      { build: { context: CHECKOUT, tags: ['ghcr.io/acme/app:1', 'launchway-check/trail-dev'] } },
    ],
    ['a built image name', { build: { context: CHECKOUT }, image: 'launchway-check/x' }],
  ])('refuses %s in the launchway-check/ namespace for deployments', (_, service) => {
    expect(violations(withService('app', service))).toEqual([
      expect.stringMatching(/launchway-check\/ namespace, which belongs to checks/),
    ]);
  });

  it('allows other images, including look-alikes outside the namespace', () => {
    for (const image of ['launchway-checks/x', 'ghcr.io/launchway-check/x', 'launchway/check']) {
      expect(violations(withService('app', { image })), image).toEqual([]);
    }
  });
});

describe('evaluateComposePolicy with trusted mounts', () => {
  const ROOTS = ['/srv/data', '/run/desktop/mnt/host/d/Backups'];
  const TRUSTED: DeployPolicy = { trustedMounts: true, allowedBindRoots: ROOTS };
  const UNTRUSTED: DeployPolicy = { trustedMounts: false, allowedBindRoots: ROOTS };

  function trail(): ComposeConfig {
    const config = parseComposeConfig(trailFixture);
    if (!config) throw new Error('fixture did not parse');
    return config;
  }

  const trailContext = (mountPolicy?: DeployPolicy): PolicyContext => ({
    ...context([], mountPolicy),
    projectName: 'launchway-trail',
  });

  /** One service binding `source` (optionally with bind options) under `policy`. */
  function bind(source: string, policy?: DeployPolicy, extra: Record<string, unknown> = {}) {
    const config = withService('bad', {
      image: 'x',
      volumes: [{ type: 'bind', source, target: '/mnt', ...extra }],
    });
    return evaluateComposePolicy(config, context([], policy));
  }

  it('allows the Trail stack once trusted and reports what trust allowed', () => {
    const result = evaluateComposePolicy(trail(), trailContext(TRUSTED));
    expect(result.violations).toEqual([]);
    expect(result.trustedMounts).toEqual([
      'service app bind-mounts /run/desktop/mnt/host/d/Backups/trail',
      'service app bind-mounts /srv/data/trail',
      'volume pgdata uses external volume trail_pgdata',
      'volume cache uses volume trail_cache',
    ]);
  });

  it.each<[string, DeployPolicy | undefined]>([
    ['without a policy (older servers)', undefined],
    ['when the app is not trusted', UNTRUSTED],
  ])('refuses the Trail stack %s, exactly as before', (_label, policy) => {
    const result = evaluateComposePolicy(trail(), trailContext(policy));
    expect(result.trustedMounts).toEqual([]);
    expect(result.violations).toEqual([
      'service "app": host bind mount "/run/desktop/mnt/host/d/Backups/trail" is not allowed (use a named volume)',
      'service "app": host bind mount "/srv/data/trail" is not allowed (use a named volume)',
      'volume "pgdata": external volumes are not allowed',
      'volume "pgdata": custom volume name "trail_pgdata" is not allowed',
      'volume "cache": custom volume name "trail_cache" is not allowed',
    ]);
  });

  it.each([
    ['the root itself', '/srv/data'],
    ['a path below a root', '/srv/data/trail/backups'],
    ['a path that normalizes below a root', '/srv/data/x/../trail'],
    ['a Docker Desktop drive below /run (the root is deeper)', '/run/desktop/mnt/host/d/Backups/x'],
    ['a relative path that resolves below a root', '../../../../srv/data/trail'],
  ])('allows a trusted bind of %s', (_label, source) => {
    expect(bind(source, TRUSTED).violations).toEqual([]);
  });

  it.each<[string, string, RegExp]>([
    ['outside every root', '/srv/other', /outside the allowed bind-mount roots/],
    ['a sibling sharing a prefix', '/srv/data-old', /outside the allowed bind-mount roots/],
    ['escaping a root with ..', '/srv/data/../../etc', /outside the allowed bind-mount roots/],
    ['a relative path into the checkout', './data', /inside the agent workspace/],
    ['a relative path into the workspace', '../../..', /inside the agent workspace/],
    ['the Docker socket', '/var/run/docker.sock', /Docker socket/],
    ['the Docker socket below a root', '/srv/data/docker.sock', /Docker socket/],
    ['the host root', '/', /host root directory/],
    ['/etc', '/etc', /outside the allowed bind-mount roots/],
    ['/run outside the Docker Desktop root', '/run/desktop/mnt/host/c', /outside the allowed/],
    ['an empty source', '', /no source/],
  ])('refuses a trusted bind %s', (_label, source, pattern) => {
    const found = bind(source, TRUSTED).violations;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(pattern);
    expect(found[0]).toContain('allowed roots: /srv/data, /run/desktop/mnt/host/d/Backups');
  });

  it('shows the resolved path of relative sources', () => {
    expect(bind('./data', TRUSTED).violations[0]).toContain(
      `bind mount "./data" (resolved "${CHECKOUT}/data")`,
    );
  });

  it.each<[string, string[], string, RegExp]>([
    ['/etc', ['/etc'], '/etc/ssl', /below the protected path \/etc/],
    ['/run', ['/run'], '/run/secrets', /below the protected path \/run/],
    ['/proc', ['/proc'], '/proc/1', /below the protected path \/proc/],
    ['/var/lib/docker', ['/var/lib'], '/var/lib/docker/volumes', /\/var\/lib\/docker can never/],
    ['the workspace', ['/ws'], '/ws/agent', /inside the agent workspace/],
  ])('keeps %s refused even when a root covers it', (_label, roots, source, pattern) => {
    const found = bind(source, { trustedMounts: true, allowedBindRoots: roots }).violations;
    expect(found.join('\n')).toMatch(pattern);
  });

  it.each(['shared', 'rshared', 'slave', 'rslave'])('refuses propagation %s', (propagation) => {
    const found = bind('/srv/data/x', TRUSTED, { bind: { propagation } }).violations;
    expect(found.join('\n')).toMatch(
      new RegExp(`propagation ${propagation}, which is not allowed`),
    );
  });

  it('allows private propagation and read-only binds', () => {
    expect(
      bind('/srv/data/x', TRUSTED, { read_only: true, bind: { propagation: 'rprivate' } })
        .violations,
    ).toEqual([]);
  });

  it('names the missing roots when the node has none', () => {
    const found = bind('/srv/data', { trustedMounts: true, allowedBindRoots: [] }).violations;
    expect(found[0]).toMatch(/outside the allowed bind-mount roots.*none configured on this node/);
  });

  it.each([
    ['an external volume', { data: { external: true, name: 'trail_pgdata' } }],
    ['an external volume without a name', { trail_pgdata: { external: true } }],
    ['a custom volume name', { data: { name: 'trail_cache' } }],
  ])('allows %s when trusted', (_label, volumes) => {
    const config = { ...base(), volumes: { ...base().volumes, ...volumes } } as ComposeConfig;
    expect(evaluateComposePolicy(config, context([], TRUSTED)).violations).toEqual([]);
    expect(evaluateComposePolicy(config, context([], UNTRUSTED)).violations).not.toEqual([]);
  });

  it.each([
    ['the database', { db: { external: true, name: 'launchway_db-data' } }],
    ['the agent workspace', { a: { external: true, name: 'launchway-agent_agent-data' } }],
    ['the Caddy data', { c: { name: 'launchway_caddy-data' } }],
  ])('refuses the platform volume of %s even when trusted', (_label, volumes) => {
    const config = { ...base(), volumes } as ComposeConfig;
    expect(evaluateComposePolicy(config, context([], TRUSTED)).violations.join()).toMatch(
      /belongs to the Launchway platform/,
    );
  });

  it('keeps refusing everything else when trusted', () => {
    const config = {
      ...withService('bad', {
        image: 'x',
        privileged: true,
        volumes: [{ type: 'npipe', source: 'x', target: 'y' }],
      }),
      volumes: {
        v: { name: 'trail_v', driver_opts: { type: 'none', o: 'bind', device: '/srv/data' } },
        p: { driver: 'local-persist' },
      },
    } as ComposeConfig;
    const found = evaluateComposePolicy(config, context([], TRUSTED)).violations.join('\n');
    expect(found).toMatch(/privileged is not allowed/);
    expect(found).toMatch(/mount type npipe/);
    expect(found).toMatch(/volumes backed by host paths/);
    expect(found).toMatch(/volume driver "local-persist"/);
  });
});

describe('evaluateComposePolicy in check mode', () => {
  const sizes: Record<string, number> = {
    [`${CHECKOUT}/small.txt`]: 100,
    [`${CHECKOUT}/limit.txt`]: MAX_INLINE_FILE_BYTES,
    [`${CHECKOUT}/big.sql`]: MAX_INLINE_FILE_BYTES + 1,
  };
  const checkContext = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
    ...context(),
    mode: 'check',
    fileSize: (path) => sizes[path] ?? null,
    ...overrides,
  });
  /** The fixture's worker builds with a docker-image:// context, which checks refuse (below). */
  const checkable = (config: ComposeConfig): ComposeConfig => {
    const copy = structuredClone(config);
    const build = copy.services.worker?.build as Record<string, unknown> | null | undefined;
    if (
      build &&
      String(Object.values(build.additional_contexts ?? {})).startsWith('docker-image:')
    ) {
      delete build.additional_contexts;
    }
    return copy;
  };
  const check = (config: ComposeConfig, overrides: Partial<PolicyContext> = {}) =>
    evaluateComposePolicy(checkable(config), checkContext(overrides));
  const bind = (source: string, extra: Record<string, unknown> = {}) =>
    withService('dev', {
      image: 'x',
      volumes: [{ type: 'bind', source, target: '/workspace', bind: {}, ...extra }],
    });

  it('refuses images of the check namespace it does not build itself', () => {
    expect(check(withService('dev', { image: 'launchway-check/other-dev' })).violations).toEqual([
      expect.stringMatching(/launchway-check\/ namespace, which belongs to checks/),
    ]);
    // Built services are tagged into the namespace by the check document anyway.
    expect(
      check(withService('dev', { build: { context: CHECKOUT }, image: 'launchway-check/x' }))
        .violations,
    ).toEqual([]);
  });

  it('allows the realistic project; published ports are dropped, not reported', () => {
    const result = check(base());
    expect(result.violations).toEqual([]);
    expect(result.ports).toEqual([]);
    expect(result.trustedMounts).toEqual([]);
  });

  it.each([
    ['the checkout itself', CHECKOUT],
    ['a directory inside it', `${CHECKOUT}/src`],
    ['a path that does not exist yet', `${CHECKOUT}/missing/dir`],
    ['a relative path inside it', './scripts'],
  ])('allows a bind of %s', (_label, source) => {
    expect(check(bind(source)).violations).toEqual([]);
  });

  it.each([
    ['/etc', '/etc'],
    ['the agent workspace', '/ws/agent'],
    ['the Docker socket', '/var/run/docker.sock'],
    ['a relative path out of the checkout', '../..'],
    ['an empty source', ''],
  ])('refuses a bind of %s', (_label, source) => {
    expect(check(bind(source)).violations).toEqual([
      `service "dev": bind mount "${source}" is not allowed: checks only bind-mount paths inside the repository`,
    ]);
  });

  it('ignores trusted mounts: a check is never trusted', () => {
    const trusted: DeployPolicy = { trustedMounts: true, allowedBindRoots: ['/srv/data'] };
    expect(check(bind('/srv/data/x'), { mountPolicy: trusted }).violations).toHaveLength(1);
    const external = { ...base(), volumes: { data: { external: true, name: 'trail_data' } } };
    expect(check(external as ComposeConfig, { mountPolicy: trusted }).violations.join()).toMatch(
      /external volumes are not allowed/,
    );
  });

  it('allows ports and container names (the check document removes them)', () => {
    const config = withService('dev', {
      image: 'x',
      container_name: 'caddy',
      ports: [{ target: 80, published: '80', protocol: 'tcp' }],
    });
    expect(check(config)).toEqual({ violations: [], ports: [], trustedMounts: [] });
  });

  it('refuses Docker Model Runner models and privileged lifecycle hooks', () => {
    const models = { ...withService('dev', { image: 'x', models: { m: null } }), models: {} };
    expect(check(models as ComposeConfig).violations).toEqual([
      'service "dev": models (Docker Model Runner) are not allowed in checks',
    ]);
    const declared = { ...base(), models: { m: { model: 'ai/smollm2' } } } as ComposeConfig;
    expect(check(declared).violations).toEqual([
      'models (Docker Model Runner) are not allowed in checks',
    ]);
    const hooks = withService('dev', {
      image: 'x',
      post_start: [{ command: ['chown', '-R', 'node', '/x'] }],
      pre_stop: [{ command: ['sh'], privileged: true }],
    });
    const refused = [
      'service "dev": privileged lifecycle hooks (post_start, pre_stop) are not allowed',
    ];
    // Refused for deployments as well: a privileged exec gets every capability.
    expect(check(hooks).violations).toEqual(refused);
    expect(violations(hooks)).toEqual(refused);
    const unprivileged = withService('dev', { image: 'x', post_start: [{ command: ['true'] }] });
    expect(check(unprivileged).violations).toEqual([]);
    expect(violations(unprivileged)).toEqual([]);
  });

  it.each<[string, string[], boolean]>([
    ['the SSH agent', ['default'], true],
    ['a key inside the repository', ['deploy=./keys/deploy'], true],
    ['a key outside the repository', ['default=/root/.ssh/id_ed25519'], false],
    ['a key in the home directory', ['default=~/.ssh/id_ed25519'], false],
    ['a list with a key outside', ['a=./keys/a,/var/lib/launchway/agent/credentials.json'], false],
  ])('checks build ssh entries in both modes: %s', (_label, ssh, allowed) => {
    const config = withService('dev', { build: { context: CHECKOUT, ssh } });
    for (const found of [check(config).violations, violations(config)]) {
      if (allowed) expect(found).toEqual([]);
      else expect(found.join()).toMatch(/build ssh key "\w+" \(.*\) is outside the repository/);
    }
  });

  it('refuses configs and secrets that services mount when they are over 64 KiB', () => {
    const config = {
      ...withService('dev', {
        image: 'x',
        configs: [{ source: 'small' }, { source: 'limit' }, { source: 'big' }],
        secrets: [{ source: 'token', target: '/run/secrets/token' }],
        build: { context: CHECKOUT, secrets: [{ source: 'npmrc' }] },
      }),
      configs: {
        small: { file: `${CHECKOUT}/small.txt` },
        limit: { file: `${CHECKOUT}/limit.txt` },
        big: { file: `${CHECKOUT}/big.sql` },
        unused: { file: `${CHECKOUT}/big.sql` },
      },
      // Secrets only builds use stay files: no limit.
      secrets: {
        token: { file: `${CHECKOUT}/missing.txt` },
        npmrc: { file: `${CHECKOUT}/big.sql` },
      },
    } as ComposeConfig;
    expect(check(config).violations).toEqual([
      `config "big": "${CHECKOUT}/big.sql" is larger than 64 KiB, the most a check passes to a service`,
      `secret "token": "${CHECKOUT}/missing.txt" is not a file in the repository`,
    ]);
  });

  it('keeps refusing configs and secrets outside the repository', () => {
    const config = {
      ...withService('dev', { image: 'x', secrets: [{ source: 's' }] }),
      secrets: { s: { file: '/var/lib/launchway/agent/credentials.json' } },
    } as ComposeConfig;
    expect(check(config).violations).toEqual([
      'secret "s": "/var/lib/launchway/agent/credentials.json" is outside the repository',
    ]);
  });

  it('refuses image mounts in checks, not in deployments', () => {
    const config = withService('dev', {
      image: 'x',
      volumes: [{ type: 'image', source: 'launchway-other-web', target: '/other' }],
    });
    expect(check(config).violations).toEqual([
      'service "dev": image mounts are not allowed in checks (use a volume or tmpfs)',
    ]);
    expect(violations(config)).toEqual([]);
  });

  it.each([
    ['a local image', 'docker-image://launchway-other-web'],
    ['another service', 'service:web'],
    ['a build target', 'target:base'],
    ['a remote repository', 'https://github.com/acme/base.git'],
    ['an OCI layout', 'oci-layout:///var/lib/launchway'],
  ])('refuses %s as an additional build context in checks', (_label, value) => {
    const config = withService('dev', {
      build: { context: CHECKOUT, additional_contexts: { extra: value } },
    });
    expect(check(config).violations).toEqual([
      `service "dev": additional_contexts "${value}" is not allowed in checks (only directories of the repository)`,
    ]);
    expect(
      check(
        withService('dev', {
          build: { context: CHECKOUT, additional_contexts: [`x=${CHECKOUT}/x`] },
        }),
      ).violations,
    ).toEqual([]);
  });

  it('keeps docker-image:// build contexts for deployments', () => {
    expect(violations(base())).toEqual([]);
  });

  it('refuses configs and secrets from the environment in checks', () => {
    const config = {
      ...withService('dev', { image: 'x', configs: [{ source: 'c' }], secrets: [{ source: 's' }] }),
      configs: { c: { environment: 'HOME' } },
      secrets: { s: { environment: 'HTTPS_PROXY' } },
    } as ComposeConfig;
    expect(check(config).violations).toEqual([
      'config "c": configs from the environment are not allowed in checks',
      'secret "s": secrets from the environment are not allowed in checks',
    ]);
    expect(violations(config)).toEqual([]);
  });

  it('refuses names the check document uses', () => {
    const config = {
      ...base(),
      volumes: { 'launchway-check-source': {} },
      configs: { 'launchway-check-file-1': { content: 'x' } },
    } as ComposeConfig;
    expect(check(config).violations).toEqual([
      'config "launchway-check-file-1": names starting with "launchway-check-" are reserved for Launchway',
      'volume "launchway-check-source": names starting with "launchway-check-" are reserved for Launchway',
    ]);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['privileged', { image: 'x', privileged: true }, /privileged is not allowed/],
    ['network_mode host', { image: 'x', network_mode: 'host' }, /network_mode host/],
    ['extra capabilities', { image: 'x', cap_add: ['SYS_ADMIN'] }, /cap_add SYS_ADMIN/],
    ['devices', { image: 'x', devices: [{ source: '/dev/kvm', target: '/dev/kvm' }] }, /devices/],
    ['security options', { image: 'x', security_opt: ['apparmor=unconfined'] }, /security_opt/],
    ['the API socket', { image: 'x', use_api_socket: true }, /use_api_socket/],
    ['provider services', { provider: { type: 'model' } }, /provider/],
    ['a runtime', { image: 'x', runtime: 'nvidia' }, /runtime/],
    ['gpus', { image: 'x', gpus: 'all' }, /gpus/],
    ['the proxy network', { image: 'x', networks: { 'launchway-proxy': null } }, /proxy network/],
    ['env files outside', { image: 'x', env_file: ['/etc/environment'] }, /env_file.*outside/],
  ])('keeps refusing %s', (_label, service, pattern) => {
    expect(check(withService('bad', service)).violations.join('\n')).toMatch(pattern);
  });

  describe('on a real checkout', () => {
    let root: string;
    let outside: string;
    beforeAll(async () => {
      const tmp = await realpath(await mkdtemp(join(tmpdir(), 'launchway-policy-')));
      root = join(tmp, 'repo');
      outside = join(tmp, 'outside');
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'credentials.json'), '{}');
      await symlink(outside, join(root, 'escape'));
      await symlink(join(outside, 'credentials.json'), join(root, 'e$nv'));
      await symlink(join(root, 'src'), join(root, 'inside'));
    });
    afterAll(async () => {
      if (root) await rm(join(root, '..'), { recursive: true, force: true });
    });
    const real = (overrides: Partial<PolicyContext> = {}) =>
      checkContext({
        projectDir: root,
        workspaceRoot: join(root, '..', 'ws'),
        isInsideCheckout: (path) => isInsideReal(root, path),
        ...overrides,
      });

    /** A project of one service, so that only its paths are checked. */
    const only = (service: Record<string, unknown>) =>
      ({ services: { dev: service } }) as unknown as ComposeConfig;

    it('refuses binds through symlinks that leave the checkout', () => {
      const config = (source: string) =>
        only({ image: 'x', volumes: [{ type: 'bind', source, target: '/w' }] });
      expect(evaluateComposePolicy(config(`${root}/inside`), real()).violations).toEqual([]);
      expect(evaluateComposePolicy(config(`${root}/escape`), real()).violations).toHaveLength(1);
      expect(evaluateComposePolicy(config('./escape/x'), real()).violations).toHaveLength(1);
    });

    it('reads `$$` in Compose output as `$`, so an escaped name cannot hide a symlink', () => {
      // `config --format json` prints the env file `e$nv` as `e$$nv`.
      const config = only({ image: 'x', env_file: [`${root}/e$$nv`] });
      const refused = [`service "dev" env_file: "${root}/e$$nv" is outside the repository`];
      expect(evaluateComposePolicy(config, real()).violations).toEqual(refused);
      expect(evaluateComposePolicy(config, real({ mode: 'deploy' })).violations).toEqual(refused);
      const bound = only({
        image: 'x',
        volumes: [{ type: 'bind', source: `${root}/e$$nv`, target: '/w' }],
      });
      expect(evaluateComposePolicy(bound, real()).violations).toHaveLength(1);
    });
  });
});
