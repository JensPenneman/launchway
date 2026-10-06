import { readFileSync } from 'node:fs';
import type { DeployRoute } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ComposeConfig,
  evaluateComposePolicy,
  type PolicyContext,
  parseComposeConfig,
} from './compose-policy.js';

const CHECKOUT = '/ws/apps/app_1/dep_1';
const fixture = readFileSync(new URL('./fixtures/mailserver.config.json', import.meta.url), 'utf8');

function context(routes: DeployRoute[] = []): PolicyContext {
  return {
    projectName: 'slipway-mail',
    proxyNetwork: 'slipway-proxy',
    routes,
    isInsideCheckout: (path) => path === CHECKOUT || path.startsWith(`${CHECKOUT}/`),
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
    ['pid host', { image: 'x', pid: 'host' }, /pid host/],
    ['ipc host', { image: 'x', ipc: 'host' }, /ipc host/],
    ['userns_mode host', { image: 'x', userns_mode: 'host' }, /userns_mode host/],
    ['extra capabilities', { image: 'x', cap_add: ['NET_ADMIN'] }, /cap_add NET_ADMIN/],
    ['cap_add ALL', { image: 'x', cap_add: ['ALL'] }, /cap_add ALL/],
    ['unconfined seccomp', { image: 'x', security_opt: ['seccomp=unconfined'] }, /security_opt/],
    ['devices', { image: 'x', devices: [{ source: '/dev/sda', target: '/dev/sda' }] }, /devices/],
    [
      'volumes_from another container',
      { image: 'x', volumes_from: ['container:slipway-agent'] },
      /volumes_from/,
    ],
    ['use_api_socket', { image: 'x', use_api_socket: true }, /use_api_socket/],
    ['provider services', { provider: { type: 'model' } }, /provider/],
    ['reserved container names', { image: 'x', container_name: 'caddy' }, /container_name "caddy"/],
    [
      'joining the proxy network',
      { image: 'x', networks: { 'slipway-proxy': null } },
      /proxy network/,
    ],
    [
      'env files outside the checkout',
      { image: 'x', env_file: [{ path: '/var/lib/slipway/agent/credentials.json' }] },
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
      { volumes: { data: { external: true, name: 'slipway_pgdata' } } },
      /external volumes/,
    ],
    [
      'custom volume names',
      { volumes: { data: { name: 'slipway-other_data' } } },
      /custom volume name/,
    ],
    [
      'volumes bound to host paths',
      {
        volumes: {
          data: {
            name: 'slipway-mail_data',
            driver_opts: { type: 'none', o: 'bind', device: '/' },
          },
        },
      },
      /host paths/,
    ],
    [
      'a declared proxy network',
      { networks: { edge: { name: 'slipway-proxy', external: true } } },
      /proxy network/,
    ],
    [
      'the default proxy network under another key',
      { networks: { 'slipway-proxy': { name: 'x' } } },
      /proxy network/,
    ],
    [
      'external networks',
      { networks: { other: { name: 'slipway-other_default', external: true } } },
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
      { secrets: { s: { file: '/var/lib/slipway/agent/credentials.json' } } },
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
