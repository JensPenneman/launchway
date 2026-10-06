import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

const ACCOUNT = '/api/v1/dns/accounts/prov_01ja53wvjvfk1sp7hz5965tvkz';
const ZONE = '/api/v1/dns/zones/zone_01ja53wvjvfk1sp7hz5965tvkz';

const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const record = { type: 'A', name: 'a.example.com', content: '192.0.2.1' };
const READS: [string, string][] = [
  ['GET', '/api/v1/dns/providers'],
  ['GET', '/api/v1/dns/accounts'],
  ['GET', ACCOUNT],
  ['GET', '/api/v1/dns/zones'],
  ['GET', `${ZONE}/records`],
  ['GET', '/api/v1/dns/ddns'],
];
const WRITES: [string, string, unknown][] = [
  ['POST', '/api/v1/dns/accounts', { kind: 'manual', name: 'x', credentials: {} }],
  ['PATCH', ACCOUNT, { name: 'y' }],
  ['DELETE', ACCOUNT, undefined],
  ['POST', `${ACCOUNT}/sync`, undefined],
  ['POST', `${ZONE}/records`, record],
  ['PATCH', `${ZONE}/records/abc`, record],
  ['DELETE', `${ZONE}/records/abc`, undefined],
];

describe('dns routes (authorization and validation)', () => {
  it('rejects anonymous callers on every route', async () => {
    const app = createApp(createTestDeps());
    for (const [method, path] of READS) {
      expect((await app.request(path, send(method))).status, `${method} ${path}`).toBe(401);
    }
    for (const [method, path, body] of [
      ...WRITES,
      ['POST', '/api/v1/dns/ddns/run', undefined],
    ] as const) {
      expect((await app.request(path, send(method, body))).status, `${method} ${path}`).toBe(401);
    }
  });

  it('rejects viewers on mutations and members on the dynamic DNS run', async () => {
    const viewer = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('viewer')) }));
    for (const [method, path, body] of WRITES) {
      expect((await viewer.request(path, send(method, body))).status, `${method} ${path}`).toBe(
        403,
      );
    }
    const member = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    expect((await member.request('/api/v1/dns/ddns/run', send('POST'))).status).toBe(403);
  });

  it('lists the provider kinds with JSON Schema credentials', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('viewer')) }));
    const res = await app.request('/api/v1/dns/providers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { kind: string; credentialsSchema: unknown }[] };
    expect(body.items.map((item) => item.kind)).toEqual(['cloudflare', 'manual']);
    expect(body.items[0]).toMatchObject({
      label: 'Cloudflare',
      capabilities: { proxied: true, ttl: true },
      credentialsSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['apiToken'],
        additionalProperties: false,
        properties: { apiToken: { type: 'string', writeOnly: true } },
      },
    });
  });

  it('validates ids, bodies and queries before touching the database', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    const cases: [string, string, unknown, string][] = [
      ['GET', '/api/v1/dns/accounts/zone_01ja53wvjvfk1sp7hz5965tvkz', undefined, 'param.id'],
      ['GET', '/api/v1/dns/zones?accountId=nope', undefined, 'query.accountId'],
      [
        'POST',
        '/api/v1/dns/accounts',
        { kind: 'Bad Kind', name: 'x', credentials: {} },
        'body.kind',
      ],
      ['PATCH', ACCOUNT, {}, 'body'],
      ['POST', `${ZONE}/records`, { ...record, content: 'not-an-ip' }, 'body.content'],
      ['POST', `${ZONE}/records`, { ...record, type: 'MX' }, 'body.type'],
      ['PATCH', `${ZONE}/records/bad%20id`, record, 'param.recordId'],
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
