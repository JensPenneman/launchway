import { generateId } from '@slipway/contracts';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { auditEvents } from '../../src/db/schema.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  body: JSON.stringify(body),
});

describe('settings against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  const admin = testPrincipal('admin');

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reports ready once migrations ran', async () => {
    const app = createApp(createTestDeps({ db }));
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('reads defaults, writes a setting and records an audit event', async () => {
    const events: string[] = [];
    const deps = createTestDeps({ db, auth: fixedAuth(admin) });
    deps.events.subscribe((event) => events.push(`${event.topic}.${event.action}`));
    const app = createApp(deps);

    const initial = await app.request('/api/v1/settings');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ publicUrl: null, dynamicDnsEnabled: false });

    const updated = await app.request(
      '/api/v1/settings',
      json('PATCH', { publicUrl: 'https://deploy.example.com/', acmeEmail: 'Ops@Example.com' }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      publicUrl: 'https://deploy.example.com',
      effectivePublicUrl: 'https://deploy.example.com',
      acmeEmail: 'ops@example.com',
    });

    const reread = (await (await app.request('/api/v1/settings')).json()) as { publicUrl: string };
    expect(reread.publicUrl).toBe('https://deploy.example.com');

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'settings.update'));
    expect(audit).toMatchObject({
      actorType: 'user',
      actorId: admin.user.id,
      actorLabel: admin.user.email,
      targetType: 'settings',
      userAgent: 'integration-test',
      summary: {
        publicUrl: { from: null, to: 'https://deploy.example.com' },
        acmeEmail: { from: null, to: 'ops@example.com' },
      },
    });
    expect(events).toEqual(['settings.updated']);
  });

  it('rejects an unknown edge node as a validation error and changes nothing', async () => {
    const app = createApp(createTestDeps({ db, auth: fixedAuth(admin) }));
    const res = await app.request(
      '/api/v1/settings',
      json('PATCH', { edgeNodeId: generateId('node') }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      type: 'validation-failed',
      errors: [{ path: 'body.edgeNodeId', message: 'Unknown node' }],
    });
    const after = (await (await app.request('/api/v1/settings')).json()) as {
      edgeNodeId: string | null;
    };
    expect(after.edgeNodeId).toBeNull();
  });
});
