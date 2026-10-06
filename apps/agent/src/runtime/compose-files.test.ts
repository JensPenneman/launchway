import { generateId } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { buildOverride, formatEnvFile, synthesizeCompose } from './compose-files.js';
import type { ComposeConfig } from './compose-policy.js';

const appId = generateId('app');
const deploymentId = generateId('dep');
const config = {
  services: {
    web: { networks: { default: null, back: null } },
    api: {},
    db: { networks: { back: null } },
  },
} as unknown as ComposeConfig;

const payload = (publishOnIp: string | null) => ({
  app: { id: appId, slug: 'trail' },
  deploymentId,
  routes: [
    { service: 'web', port: 8080, alias: 'trail-web' },
    { service: 'web', port: 9090, alias: 'trail-web' },
    { service: 'api', port: 3000, alias: 'trail-api' },
  ],
  network: { proxyNetwork: 'slipway-proxy', publishOnIp },
});

describe('buildOverride', () => {
  it('labels every service and attaches routed services to the proxy network', () => {
    const override = buildOverride(config, payload(null));
    expect(override).toEqual({
      services: {
        api: {
          labels: {
            'slipway.app': appId,
            'slipway.deployment': deploymentId,
            'slipway.service': 'api',
          },
          networks: { default: {}, 'slipway-proxy': { aliases: ['trail-api'] } },
        },
        db: {
          labels: {
            'slipway.app': appId,
            'slipway.deployment': deploymentId,
            'slipway.service': 'db',
          },
        },
        web: {
          labels: {
            'slipway.app': appId,
            'slipway.deployment': deploymentId,
            'slipway.service': 'web',
          },
          networks: { default: {}, back: {}, 'slipway-proxy': { aliases: ['trail-web'] } },
        },
      },
      networks: { 'slipway-proxy': { external: true, name: 'slipway-proxy' } },
    });
  });

  it('publishes routed ports on the LAN IP with ephemeral host ports off the edge node', () => {
    const override = buildOverride(config, payload('192.168.1.20')) as {
      services: Record<string, { ports?: unknown }>;
    };
    expect(override.services.web?.ports).toEqual([
      { target: 8080, host_ip: '192.168.1.20', protocol: 'tcp' },
      { target: 9090, host_ip: '192.168.1.20', protocol: 'tcp' },
    ]);
    expect(override.services.api?.ports).toEqual([
      { target: 3000, host_ip: '192.168.1.20', protocol: 'tcp' },
    ]);
    expect(override.services.db?.ports).toBeUndefined();
  });
});

describe('synthesizeCompose', () => {
  it('builds one service from the Dockerfile and context', () => {
    expect(
      synthesizeCompose(
        { kind: 'dockerfile', dockerfile: 'docker/Dockerfile', context: '.' },
        '/ws/d',
      ),
    ).toEqual({
      services: {
        app: {
          build: { context: './.', dockerfile: '/ws/d/docker/Dockerfile' },
          env_file: [{ path: './.env', required: true }],
          restart: 'unless-stopped',
        },
      },
    });
  });
});

describe('formatEnvFile', () => {
  it('single-quotes plain values and escapes the rest in double quotes', () => {
    expect(
      formatEnvFile({
        PLAIN: 'p@ss $HOME "x" \\',
        QUOTE: "it's",
        MULTI: 'a\nb\r$X\\"',
        EMPTY: '',
      }),
    ).toBe(
      [
        "EMPTY=''",
        'MULTI="a\\nb\\r\\$X\\\\\\""',
        'PLAIN=\'p@ss $HOME "x" \\\'',
        'QUOTE="it\'s"',
        '',
      ].join('\n'),
    );
  });
});
