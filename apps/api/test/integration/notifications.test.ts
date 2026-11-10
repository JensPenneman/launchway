import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { auditEvents } from '../../src/db/schema.js';
import { createNotifier } from '../../src/modules/notifications/ntfy.js';
import { settings } from '../../src/modules/settings/schema.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  body: JSON.stringify(body),
});

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
  url: string | undefined;
}

describe('ntfy notifications against PostgreSQL and a local sink', () => {
  let pool: pg.Pool;
  let db: Database;
  let sink: Server;
  let sinkUrl: string;
  let sinkOrigin: string;
  let received: Received[];
  let statuses: number[];
  const admin = testPrincipal('admin');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: req.url,
        });
        res.statusCode = statuses.shift() ?? 200;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    sinkOrigin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    sinkUrl = `${sinkOrigin}/launchway`;
  });

  afterAll(async () => {
    await new Promise((resolve) => sink.close(resolve));
    await pool.end();
  });

  beforeEach(async () => {
    received = [];
    statuses = [];
    await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
    await db
      .update(settings)
      .set({ notifyUrl: null, notifyTokenEncrypted: null })
      .where(eq(settings.id, 1));
  });

  it('does nothing while no URL is configured', async () => {
    const notify = createNotifier(createTestDeps({ db }));
    expect(await notify({ title: 't', priority: 'low', body: 'b' })).toMatchObject({
      delivered: false,
      reason: 'not-configured',
    });
    expect(received).toEqual([]);
  });

  it('stores the token encrypted and write-only, and delivers to the sink with it', async () => {
    const deps = createTestDeps({ db, auth: fixedAuth(admin) });
    const app = createApp(deps);
    const topic = 'https://ntfy.example.test/launchway';
    const res = await app.request(
      '/api/v1/settings',
      patch({ notifyUrl: topic, notifyToken: 'tk_sink_secret' }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ notifyUrlSet: true, notifyTokenSet: true });
    expect(text).not.toContain('tk_sink_secret');
    expect(text).not.toContain(topic);
    const reread = await (await app.request('/api/v1/settings')).text();
    expect(reread).not.toContain(topic);

    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    expect(row?.notifyTokenEncrypted).toMatch(/^v1\./);
    expect(row?.notifyTokenEncrypted).not.toContain('tk_sink_secret');

    const audit = JSON.stringify(
      await db.select().from(auditEvents).where(eq(auditEvents.action, 'settings.update')),
    );
    expect(audit).not.toContain('tk_sink_secret');
    expect(audit).not.toContain(topic);

    // The https topic is reached through the local sink: only the origin is rewritten.
    const toSink: typeof fetch = (input, init) =>
      fetch(String(input).replace('https://ntfy.example.test', sinkOrigin), init);
    const notify = createNotifier(deps, { fetch: toSink, sleep: async () => {} });
    const result = await notify({
      title: 'Merged #7',
      priority: 'default',
      tags: ['merge'],
      click: 'https://github.com/o/r/pull/7',
      body: 'PR #7 merged\nin one line',
    });
    expect(result).toEqual({ delivered: true, tries: 1 });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/launchway');
    expect(received[0]?.body).toBe('PR #7 merged in one line');
    expect(received[0]?.headers).toMatchObject({
      authorization: 'Bearer tk_sink_secret',
      title: 'Merged #7',
      tags: 'merge',
    });

    // A token never travels over http, whichever way the URL got there.
    const insecure = await app.request(
      '/api/v1/settings',
      patch({ notifyUrl: 'http://ntfy.example.test/launchway' }),
    );
    expect(insecure.status).toBe(400);

    const cleared = await app.request('/api/v1/settings', patch({ notifyToken: null }));
    expect(await cleared.json()).toMatchObject({ notifyTokenSet: false });
  });

  it('retries a failing sink and gives up after three tries', async () => {
    await db.update(settings).set({ notifyUrl: sinkUrl }).where(eq(settings.id, 1));
    const notify = createNotifier(createTestDeps({ db }), { sleep: async () => {} });
    statuses = [503, 503, 200];
    expect(await notify({ title: 't', priority: 'low', body: 'b' })).toEqual({
      delivered: true,
      tries: 3,
    });
    expect(received).toHaveLength(3);

    received = [];
    statuses = [500, 500, 500, 200];
    expect(await notify({ title: 't', priority: 'low', body: 'b' })).toEqual({
      delivered: false,
      tries: 3,
      reason: 'rejected',
    });
    expect(received).toHaveLength(3);
  });

  it('answers 403 to API tokens and password sessions on the notification fields', async () => {
    const owner = testPrincipal('owner');
    const token = {
      kind: 'token' as const,
      user: owner.user,
      tokenId: 'tok_01ja53wvjvfk1sp7hz5965tvkz' as const,
      scopes: ['read' as const, 'write' as const, 'admin' as const],
    };
    const app = createApp(createTestDeps({ db, auth: fixedAuth(token) }));
    for (const body of [{ notifyToken: 'tk_x' }, { notifyUrl: sinkUrl }]) {
      expect((await app.request('/api/v1/settings', patch(body))).status).toBe(403);
    }
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    expect(row?.notifyUrl).toBeNull();
    expect(row?.notifyTokenEncrypted).toBeNull();
    const password = createApp(
      createTestDeps({ db, auth: fixedAuth(testPrincipal('owner', 'password')) }),
    );
    expect(
      (await password.request('/api/v1/settings', patch({ notifyToken: 'tk_x' }))).status,
    ).toBe(403);
    // other settings stay writable with the same token
    expect(
      (await app.request('/api/v1/settings', patch({ dynamicDnsEnabled: false }))).status,
    ).toBe(200);
  });
});
