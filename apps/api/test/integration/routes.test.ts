import { generateId, type Route, type RoutePage } from '@launchway/contracts';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { auditEvents } from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { insertApp, insertDomain, insertNode, unique } from '../support/edge-fixtures.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('routes against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    deps = createTestDeps({ db, auth: fixedAuth(testPrincipal('member')) });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates, reads, updates and deletes a route with audit events and change events', async () => {
    const app = createApp(deps);
    const events: string[] = [];
    deps.events.subscribe((event) => events.push(`${event.topic}.${event.action}`));
    const domain = await insertDomain(db);

    const created = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: domain.id,
        target: { kind: 'external', scheme: 'http', host: 'HOST.docker.internal', port: 7878 },
      }),
    );
    expect(created.status).toBe(201);
    const route = (await created.json()) as Route;
    expect(route).toMatchObject({
      hostname: domain.hostname,
      target: { kind: 'external', host: 'host.docker.internal', port: 7878 },
      protected: false,
      compress: true,
      hsts: true,
    });

    const duplicate = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: domain.id,
        target: { kind: 'redirect', to: 'https://example.com' },
      }),
    );
    expect(duplicate.status).toBe(409);

    const updated = await app.request(
      `/api/v1/routes/${route.id}`,
      json('PATCH', {
        target: { kind: 'redirect', to: 'https://example.com/new', permanent: true },
        hsts: false,
      }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      target: { kind: 'redirect', to: 'https://example.com/new', permanent: true },
      hsts: false,
    });

    const insecure = await app.request(
      `/api/v1/routes/${route.id}`,
      json('PATCH', { target: { kind: 'redirect', to: 'http://example.com' } }),
    );
    expect(insecure.status).toBe(400);
    expect(await insecure.json()).toMatchObject({ errors: [{ path: 'body.target.to' }] });

    expect((await app.request(`/api/v1/routes/${route.id}`, json('DELETE'))).status).toBe(204);
    expect((await app.request(`/api/v1/routes/${route.id}`)).status).toBe(404);

    const actions = (
      await db.select().from(auditEvents).where(eq(auditEvents.targetId, route.id))
    ).map((row) => row.action);
    expect(actions.sort()).toEqual(['route.create', 'route.delete', 'route.update']);
    expect(events).toEqual(['routes.created', 'routes.updated', 'routes.deleted']);
  });

  it('validates domains and apps and rejects network alias collisions across apps', async () => {
    const app = createApp(deps);
    const node = await insertNode(db);
    const base = unique('s');
    const shop = await insertApp(db, node, base);
    const shopApi = await insertApp(db, node, `${base}-api`);

    const unknownDomain = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: generateId('dom'),
        target: { kind: 'app', appId: shop, service: 'web', port: 80 },
      }),
    );
    expect(unknownDomain.status).toBe(400);
    expect(await unknownDomain.json()).toMatchObject({ errors: [{ path: 'body.domainId' }] });

    const first = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: (await insertDomain(db)).id,
        target: { kind: 'app', appId: shop, service: 'api-web', port: 8080 },
      }),
    );
    expect(first.status).toBe(201);

    // shop-api + web yields the same alias as shop + api-web.
    const clash = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: (await insertDomain(db)).id,
        target: { kind: 'app', appId: shopApi, service: 'web', port: 8080 },
      }),
    );
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { detail: string }).detail).toContain(`${base}-api-web`);

    // The same app may route the same service again.
    const again = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: (await insertDomain(db)).id,
        target: { kind: 'app', appId: shop, service: 'api-web', port: 8080 },
      }),
    );
    expect(again.status).toBe(201);

    const unknownApp = await app.request(
      '/api/v1/routes',
      json('POST', {
        domainId: (await insertDomain(db)).id,
        target: { kind: 'app', appId: generateId('app'), service: 'web', port: 80 },
      }),
    );
    expect(unknownApp.status).toBe(400);
    expect(await unknownApp.json()).toMatchObject({ errors: [{ path: 'body.target.appId' }] });

    const page = (await (
      await app.request(`/api/v1/routes?appId=${shop}&limit=1`)
    ).json()) as RoutePage;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = (await (
      await app.request(`/api/v1/routes?appId=${shop}&limit=1&cursor=${page.nextCursor}`)
    ).json()) as RoutePage;
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    expect(next.nextCursor).toBeNull();

    const byDomain = (await (
      await app.request(`/api/v1/routes?domainId=${page.items[0]?.domainId}`)
    ).json()) as RoutePage;
    expect(byDomain.items.map((r) => r.id)).toEqual([page.items[0]?.id]);
  });
});
