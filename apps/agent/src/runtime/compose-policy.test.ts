import { readFileSync } from 'node:fs';
import type { DeployPolicy, DeployRoute } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ComposeConfig,
  evaluateComposePolicy,
  type PolicyContext,
  parseComposeConfig,
} from './compose-policy.js';

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
