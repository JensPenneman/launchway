import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

const DOMAIN = '/api/v1/domains/dom_01ja53wvjvfk1sp7hz5965tvkz';

const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const WRITES: [string, string, unknown][] = [
  ['POST', '/api/v1/domains', { hostname: 'app.example.com' }],
  ['PATCH', DOMAIN, { force: true }],
  ['DELETE', DOMAIN, undefined],
  ['POST', `${DOMAIN}/verify`, undefined],
];

describe('domains routes (authorization and validation)', () => {
  it('rejects anonymous callers on every route', async () => {
    const app = createApp(createTestDeps());
    for (const [method, path, body] of [
      ['GET', '/api/v1/domains', undefined],
      ['GET', DOMAIN, undefined],
      ...WRITES,
    ] as const) {
      expect((await app.request(path, send(method, body))).status, `${method} ${path}`).toBe(401);
    }
  });

  it('rejects viewers on mutations', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('viewer')) }));
    for (const [method, path, body] of WRITES) {
      expect((await app.request(path, send(method, body))).status, `${method} ${path}`).toBe(403);
    }
  });

  it('validates ids, bodies and queries before touching the database', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    const cases: [string, string, unknown, string][] = [
      ['GET', '/api/v1/domains/app_01ja53wvjvfk1sp7hz5965tvkz', undefined, 'param.id'],
      ['GET', '/api/v1/domains?status=broken', undefined, 'query.status'],
      ['GET', '/api/v1/domains?limit=0', undefined, 'query.limit'],
      ['POST', '/api/v1/domains', { hostname: 'localhost' }, 'body.hostname'],
      ['POST', '/api/v1/domains', { hostname: 'a.example.com', zoneId: 'dom_x' }, 'body.zoneId'],
      ['POST', '/api/v1/domains', { hostname: 'a.example.com', extra: 1 }, 'body'],
      ['PATCH', DOMAIN, {}, 'body'],
    ];
    for (const [method, path, body, field] of cases) {
      const res = await app.request(path, send(method, body));
      expect(res.status, `${method} ${path}`).toBe(400);
      const problem = (await res.json()) as { type: string; errors: { path: string }[] };
      expect(problem.type).toBe('validation-failed');
      expect(problem.errors.map((e) => e.path)).toContain(field);
    }
  });
});
