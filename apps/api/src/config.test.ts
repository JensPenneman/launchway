import { describe, expect, it } from 'vitest';
import { ConfigError, caddyAdminListen, loadConfig } from './config.js';

const key = Buffer.alloc(32, 7).toString('base64');
const base = { DATABASE_URL: 'postgres://slipway:pw@db:5432/slipway', SLIPWAY_SECRET_KEY: key };

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      env: 'production',
      listen: { host: '0.0.0.0', port: 3000 },
      publicUrl: null,
      caddyAdminUrl: 'unix:///run/caddy-admin/admin.sock',
      caddyAdminListen: 'unix//run/caddy-admin/admin.sock|0222',
      proxyNetwork: 'slipway-proxy',
      trustedProxies: ['10.210.0.2/32'],
      logLevel: 'info',
    });
    expect(config.secretKey).toHaveLength(32);
  });

  it('derives the Caddy admin listener from the admin URL', () => {
    expect(caddyAdminListen('unix:///var/run/caddy.sock')).toBe('unix//var/run/caddy.sock|0222');
    expect(caddyAdminListen('http://caddy:2019')).toBe('0.0.0.0:2019');
    expect(loadConfig({ ...base, SLIPWAY_CADDY_ADMIN_URL: 'http://localhost:2020' })).toMatchObject(
      { caddyAdminUrl: 'http://localhost:2020', caddyAdminListen: '0.0.0.0:2020' },
    );
  });

  it('parses listen addresses, proxies and the public URL; empty values count as unset', () => {
    const config = loadConfig({
      ...base,
      SLIPWAY_LISTEN: '[::]:8080',
      SLIPWAY_TRUSTED_PROXIES: '10.0.0.0/8, fd00::/8',
      SLIPWAY_PUBLIC_URL: 'https://deploy.example.com/',
      SLIPWAY_ACME_EMAIL: '',
    });
    expect(config.listen).toEqual({ host: '::', port: 8080 });
    expect(config.trustedProxies).toEqual(['10.0.0.0/8', 'fd00::/8']);
    expect(config.publicUrl).toBe('https://deploy.example.com');
    expect(config.acmeEmail).toBeNull();
  });

  it('reports every invalid variable without echoing secret values', () => {
    const secret = 'c2hvcnQ=';
    try {
      loadConfig({
        DATABASE_URL: 'mysql://x',
        SLIPWAY_SECRET_KEY: secret,
        SLIPWAY_TRUSTED_PROXIES: '10.0.0.0/99',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('SLIPWAY_SECRET_KEY');
      expect(message).toContain('SLIPWAY_TRUSTED_PROXIES');
      expect(message).not.toContain(secret);
    }
  });

  it('requires the database URL and secret key', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*SLIPWAY_SECRET_KEY/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://db/slipway' })).toThrow(
      'SLIPWAY_SECRET_KEY: is required (see deploy/.env.example)',
    );
  });
});
