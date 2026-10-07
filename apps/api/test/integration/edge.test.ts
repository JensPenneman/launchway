import { get } from 'node:http';
import type { EdgeConfig, ServiceStatus } from '@launchway/contracts';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { deployments, routes, settings } from '../../src/db/schema.js';
import { CaddyError, createCaddyAdmin } from '../../src/modules/edge/caddy.js';
import { renderEdge } from '../../src/modules/edge/render.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { insertApp, insertDomain, insertNode, unique } from '../support/edge-fixtures.js';

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
      .withExposedPorts(2019, 80)
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
      adminListen: '0.0.0.0:2019',
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

  /** A plain-HTTP request to Caddy's port 80 for `host`. */
  function fetchSite(host: string): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      get(
        { host: caddy.getHost(), port: caddy.getMappedPort(80), path: '/', headers: { host } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          );
        },
      ).on('error', reject);
    });
  }

  it('answers 503 with the placeholder page while the routed app does not run', async () => {
    const appId = 'app_01jbh8m4x2f8k9z0a1b2c3d407';
    const { caddyfile } = renderEdge({
      adminListen: '0.0.0.0:2019',
      settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
      routes: [
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d407',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d407',
          // A plain-HTTP site address: tests obtain no certificates.
          hostname: 'http://idle.example.com',
          domain: { status: 'verified', force: false },
          target: { kind: 'app', appId, service: 'web', port: 8080 },
          protected: false,
          compress: true,
          hsts: false,
        },
      ],
      apps: [
        {
          id: appId,
          slug: 'idle',
          nodeId: 'node_01jbh8m4x2f8k9z0a1b2c3d407',
          runningServices: null,
        },
      ],
      nodes: [],
    });
    await createCaddyAdmin(adminUrl).load(caddyfile);

    const response = await fetchSite('idle.example.com');
    expect(response.status).toBe(503);
    expect(response.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '30',
    });
    expect(response.body).toMatch(/^<!doctype html>\n<html lang="en">\n/);
    expect(response.body).toContain('deployment in progress / not running');
    expect(response.body).not.toMatch(/<script|\t/);
  });

  it('renders the placeholder from the database until the deployment runs', async () => {
    // On the edge node when one is set (another file may have left it), else by alias anyway.
    const [current] = await db
      .select({ edgeNodeId: settings.edgeNodeId })
      .from(settings)
      .where(eq(settings.id, 1));
    const nodeId = current?.edgeNodeId ?? (await insertNode(db));
    const slug = unique('app');
    const appId = await insertApp(db, nodeId, slug);
    const domain = await insertDomain(db);
    await db
      .insert(routes)
      .values({ domainId: domain.id, targetKind: 'app', appId, appService: 'web', appPort: 8080 });
    const base = createTestDeps({ db, auth: fixedAuth(testPrincipal('admin')) });
    const app = createApp({
      ...base,
      config: { ...base.config, caddyAdminUrl: adminUrl, caddyAdminListen: '0.0.0.0:2019' },
    });
    const site = async () => {
      const config = (await (await app.request('/api/v1/edge/config')).json()) as EdgeConfig;
      const start = config.caddyfile.indexOf(`\n${domain.hostname} {\n`);
      const heading = config.caddyfile.lastIndexOf('\n#', start);
      return config.caddyfile.slice(heading + 1, config.caddyfile.indexOf('\n}\n', start));
    };
    const service = (name: string): ServiceStatus => ({
      service: name,
      containerId: `c-${name}`,
      state: 'running',
      health: 'healthy',
      publishedPorts: [],
    });

    expect(await site()).toContain(`placeholder (503), app ${slug} has no running deployment`);
    // Caddy accepts the placeholder sites next to everything else in the database.
    const reload = await app.request('/api/v1/edge/reload', { method: 'POST' });
    expect(reload.status).toBe(200);
    expect(hostsOf(await runningConfig())).toContain(domain.hostname);

    const [deployment] = await db
      .insert(deployments)
      .values({
        appId,
        nodeId,
        ref: 'v1.0.0',
        commitSha: 'a'.repeat(40),
        status: 'running',
        services: [service('web')],
      })
      .returning({ id: deployments.id });
    if (!deployment) throw new Error('deployment insert failed');
    expect(await site()).toContain(`reverse_proxy ${slug}-web:8080`);

    // Renamed service: the running deployment no longer has the routed one.
    await db
      .update(deployments)
      .set({ services: [service('frontend')] })
      .where(eq(deployments.id, deployment.id));
    expect(await site()).toContain(
      `placeholder (503), service web is not part of the running deployment of app ${slug}`,
    );

    await db
      .update(deployments)
      .set({ status: 'stopped' })
      .where(eq(deployments.id, deployment.id));
    expect(await site()).toContain(`placeholder (503), app ${slug} has no running deployment`);
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
    const deps = {
      ...base,
      config: { ...base.config, caddyAdminUrl: adminUrl, caddyAdminListen: '0.0.0.0:2019' },
    };
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

  it('loads a gate reached by alias and a site with extra directives', async () => {
    const appId = 'app_01jbh8m4x2f8k9z0a1b2c3d405';
    const { caddyfile } = renderEdge({
      adminListen: '0.0.0.0:2019',
      settings: {
        publicUrl: null,
        acmeEmail: 'ops@example.com',
        forwardAuthUrl: null,
        forwardAuthTarget: { appId, service: 'oauth2-proxy', port: 4180, uri: '/oauth2/auth' },
        edgeNodeId: null,
      },
      routes: [
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d405',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d405',
          hostname: 'login.example.com',
          domain: { status: 'verified', force: false },
          target: { kind: 'app', appId, service: 'pocket-id', port: 1411 },
          protected: false,
          compress: true,
          hsts: true,
          extraDirectives: [
            'handle /oauth2/* {',
            '\treverse_proxy login-oauth2-proxy:4180',
            '}',
            '@closed path /setup* /signup* /api/signup*',
            'respond @closed 404',
            'request_header -X-API-KEY',
          ].join('\n'),
        },
        {
          id: 'rt_01jbh8m4x2f8k9z0a1b2c3d406',
          domainId: 'dom_01jbh8m4x2f8k9z0a1b2c3d406',
          hostname: 'private.example.com',
          domain: { status: 'verified', force: false },
          target: { kind: 'external', scheme: 'http', host: 'host.docker.internal', port: 8080 },
          protected: true,
          compress: true,
          hsts: true,
        },
      ],
      apps: [
        {
          id: appId,
          slug: 'login',
          nodeId: 'node_01jbh8m4x2f8k9z0a1b2c3d405',
          runningServices: null,
        },
      ],
      nodes: [],
    });
    expect(caddyfile).toContain('forward_auth http://login-oauth2-proxy:4180 {');
    await createCaddyAdmin(adminUrl).load(caddyfile);
    expect(hostsOf(await runningConfig())).toEqual(
      expect.arrayContaining(['login.example.com', 'private.example.com']),
    );
  });

  it('validates extra directives of a route with Caddy on save', async () => {
    const domain = await insertDomain(db);
    const [route] = await db
      .insert(routes)
      .values({
        domainId: domain.id,
        targetKind: 'external',
        externalScheme: 'http',
        externalHost: 'host.docker.internal',
        externalPort: 8097,
      })
      .returning({ id: routes.id });
    const base = createTestDeps({ db, auth: fixedAuth(testPrincipal('admin')) });
    const app = createApp({ ...base, config: { ...base.config, caddyAdminUrl: adminUrl } });

    const rejected = await app.request(`/api/v1/routes/${route?.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extraDirectives: 'encode gzip\nbogus_directive on' }),
    });
    expect(rejected.status).toBe(400);
    const problem = (await rejected.json()) as { errors: { path: string; message: string }[] };
    expect(problem.errors[0]?.path).toBe('body.extraDirectives');
    expect(problem.errors[0]?.message).toMatch(/line 2.*bogus_directive/);

    const accepted = await app.request(`/api/v1/routes/${route?.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extraDirectives: 'request_header -X-API-KEY' }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      extraDirectives: 'request_header -X-API-KEY',
      warnings: [],
    });
  });
});
