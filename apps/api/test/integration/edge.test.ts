import { get } from 'node:http';
import type { EdgeConfig } from '@slipway/contracts';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { routes } from '../../src/db/schema.js';
import { CaddyError, createCaddyAdmin } from '../../src/modules/edge/caddy.js';
import { renderEdge } from '../../src/modules/edge/render.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { insertDomain } from '../support/edge-fixtures.js';

const BOOTSTRAP = '{\n\tadmin 0.0.0.0:2019\n\tcert_issuer acme\n}\n';

/** Every `host` matcher value in a Caddy JSON configuration. */
function hostsOf(config: unknown): string[] {
  const hosts: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'host' && Array.isArray(child)) hosts.push(...child.map(String));
        else visit(child);
      }
    }
  };
  visit(config);
  return hosts;
}

describe('edge configuration loaded into a real Caddy', () => {
  let caddy: StartedTestContainer;
  let adminUrl: string;
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    caddy = await new GenericContainer('caddy:2-alpine')
      .withCopyContentToContainer([{ content: BOOTSTRAP, target: '/etc/caddy/Caddyfile' }])
      // No certificate traffic from tests: the ACME directory resolves to nowhere.
      .withExtraHosts([{ host: 'acme-v02.api.letsencrypt.org', ipAddress: '127.0.0.1' }])
      .withExposedPorts(2019)
      .withWaitStrategy(Wait.forHttp('/config/', 2019))
      .start();
    adminUrl = `http://${caddy.getHost()}:${caddy.getMappedPort(2019)}`;
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
    await caddy?.stop();
  });

  /** GET /config/ with node:http (Caddy refuses fetch's CORS-mode requests). */
  function runningConfig(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      get(`${adminUrl}/config/`, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode === 200) resolve(JSON.parse(body));
          else reject(new Error(`GET /config/ answered ${response.statusCode}: ${body}`));
        });
      }).on('error', reject);
    });
  }

  it('validates and loads a rendered Caddyfile with every target kind', async () => {
    const { caddyfile } = renderEdge({
      settings: {
        publicUrl: 'https://deploy.example.com',
        acmeEmail: 'ops@example.com',
        forwardAuthUrl: 'http://gate-proxy:4180/oauth2/auth',
        edgeNodeId: null,
      },
      routes: [
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d401',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d401',
          hostname: 'radarr.example.com',
          domain: { status: 'verified', force: false },
          target: { kind: 'external', scheme: 'http', host: 'host.docker.internal', port: 7878 },
          protected: true,
          compress: true,
          hsts: true,
        },
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d402',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d402',
          hostname: 'nas.example.com',
          domain: { status: 'verified', force: false },
          target: { kind: 'external', scheme: 'https', host: 'nas.lan', port: 5001 },
          protected: false,
          compress: false,
          hsts: false,
        },
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d403',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d403',
          hostname: 'old.example.com',
          domain: { status: 'pending', force: true },
          target: { kind: 'redirect', to: 'https://new.example.com/', permanent: true },
          protected: false,
          compress: true,
          hsts: true,
        },
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d404',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d404',
          hostname: 'trail.example.com',
          domain: { status: 'verified', force: false },
          target: {
            kind: 'app',
            appId: 'app_01jbh8m4x2f8k9z0a1b2c3d404',
            service: 'web',
            port: 8080,
          },
          protected: false,
          compress: true,
          hsts: true,
        },
      ],
      apps: [
        {
          id: 'app_01jbh8m4x2f8k9z0a1b2c3d404',
          slug: 'trail',
          nodeId: 'node_01jbh8m4x2f8k9z0a1b2c3d404',
          runningServices: null,
        },
      ],
      nodes: [],
    });

    await createCaddyAdmin(adminUrl).load(caddyfile);
    const hosts = hostsOf(await runningConfig());
    expect(hosts).toEqual(
      expect.arrayContaining([
        'deploy.example.com',
        'radarr.example.com',
        'nas.example.com',
        'old.example.com',
        'trail.example.com',
      ]),
    );
  });

  it('reports Caddy’s own message for an invalid configuration', async () => {
    const error = await createCaddyAdmin(adminUrl)
      .load('example.com {\n\tnot_a_directive\n}\n')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CaddyError);
    expect((error as CaddyError).message).toContain('not_a_directive');
  });

  it('renders the routes from the database and loads them through POST /edge/reload', async () => {
    const domain = await insertDomain(db);
    await db.insert(routes).values({
      domainId: domain.id,
      targetKind: 'external',
      externalScheme: 'http',
      externalHost: 'host.docker.internal',
      externalPort: 8096,
    });
    const base = createTestDeps({ db, auth: fixedAuth(testPrincipal('admin')) });
    const deps = { ...base, config: { ...base.config, caddyAdminUrl: adminUrl } };
    const app = createApp(deps);

    const before = (await (await app.request('/api/v1/edge/config')).json()) as EdgeConfig;
    expect(before.caddyfile).toContain(`${domain.hostname} {`);
    expect(before.inSync).toBe(false);

    const res = await app.request('/api/v1/edge/reload', { method: 'POST' });
    expect(res.status).toBe(200);
    const loaded = (await res.json()) as EdgeConfig;
    expect(loaded).toMatchObject({ inSync: true, lastError: null });
    expect(loaded.loadedAt).not.toBeNull();
    expect(hostsOf(await runningConfig())).toContain(domain.hostname);

    const failing = createApp({
      ...deps,
      config: { ...deps.config, caddyAdminUrl: 'http://127.0.0.1:9' },
    });
    const unreachable = await failing.request('/api/v1/edge/reload', { method: 'POST' });
    expect(unreachable.status).toBe(503);
    expect(await unreachable.json()).toMatchObject({ type: 'service-unavailable' });
  });
});
