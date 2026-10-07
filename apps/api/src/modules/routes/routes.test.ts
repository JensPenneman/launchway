import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';
import { ProblemError } from '../../lib/problem.js';
import { CaddyError } from '../edge/caddy.js';
import {
  assertRedirectTarget,
  checkRouteDirectives,
  findAliasClash,
  routeAlias,
} from './validation.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const routeId = generateId('rt');
const validCreate = {
  domainId: generateId('dom'),
  target: { kind: 'external', scheme: 'http', host: 'host.docker.internal', port: 7878 },
};

describe('route validation rules', () => {
  it('detects network alias collisions across apps', () => {
    const others = [
      { slug: 'shop', service: 'api-db' },
      { slug: 'blog', service: null },
    ];
    expect(findAliasClash(routeAlias('shop-api', 'db', 'body.target'), others)).toEqual({
      slug: 'shop',
      service: 'api-db',
    });
    expect(findAliasClash(routeAlias('shop', 'web', 'body.target'), others)).toBeUndefined();
  });

  it('rejects aliases longer than 63 characters as a field error', () => {
    let error: unknown;
    try {
      routeAlias('a'.repeat(40), 'b'.repeat(30), 'body.target');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ errors: [{ path: 'body.target.service' }] });
  });

  it('accepts only https redirects', () => {
    expect(() =>
      assertRedirectTarget({ kind: 'redirect', to: 'http://example.com', permanent: false }, 'b'),
    ).toThrow(ProblemError);
    expect(() =>
      assertRedirectTarget({ kind: 'redirect', to: 'https://example.com', permanent: true }, 'b'),
    ).not.toThrow();
  });
});

describe('extra directives validation (fake Caddy adapter)', () => {
  const site = { hostname: 'login.example.com', protected: true, compress: true, hsts: true };

  it("turns Caddy's rejection into a validation problem for body.extraDirectives", async () => {
    const adapted: string[] = [];
    const caddy = {
      adapt: (caddyfile: string) => {
        adapted.push(caddyfile);
        const line = caddyfile.split('\n').indexOf('\tnope') + 1;
        return Promise.reject(
          new CaddyError(`Caddyfile:${line}: unrecognized directive: nope`, false),
        );
      },
    };
    const error = await checkRouteDirectives(caddy, site, 'encode gzip\nnope').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({
      type: 'validation-failed',
      detail: 'Caddy rejected the extra directives: line 2: unrecognized directive: nope',
      errors: [{ path: 'body.extraDirectives', message: 'line 2: unrecognized directive: nope' }],
    });
    expect(adapted[0]).toContain('\timport gate');
  });

  it('passes valid directives and skips Caddy when there are none', async () => {
    let calls = 0;
    const caddy = {
      adapt: () => {
        calls += 1;
        return Promise.resolve({});
      },
    };
    await expect(checkRouteDirectives(caddy, site, 'request_header -X-API-KEY')).resolves.toEqual(
      [],
    );
    await expect(checkRouteDirectives(caddy, site, null)).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
});

describe('routes routes (authorization and validation)', () => {
  it('rejects anonymous callers with 401', async () => {
    const app = createApp(createTestDeps());
    expect((await app.request('/api/v1/routes')).status).toBe(401);
    expect((await app.request('/api/v1/routes', json('POST', validCreate))).status).toBe(401);
  });

  it('rejects viewers on mutations with 403', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('viewer')) }));
    expect((await app.request('/api/v1/routes', json('POST', validCreate))).status).toBe(403);
    expect(
      (await app.request(`/api/v1/routes/${routeId}`, json('PATCH', { hsts: false }))).status,
    ).toBe(403);
    expect((await app.request(`/api/v1/routes/${routeId}`, json('DELETE'))).status).toBe(403);
  });

  it('validates bodies and queries before touching the database', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    const reserved = await app.request(
      '/api/v1/routes',
      json('POST', {
        ...validCreate,
        target: { kind: 'app', appId: generateId('app'), service: 'caddy', port: 80 },
      }),
    );
    expect(reserved.status).toBe(400);
    const empty = await app.request(`/api/v1/routes/${routeId}`, json('PATCH', {}));
    expect(empty.status).toBe(400);
    const badQuery = await app.request('/api/v1/routes?limit=1000&domainId=nope');
    expect(badQuery.status).toBe(400);
  });

  it('keeps extra directives admin only and bounded', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    const member = await app.request(
      '/api/v1/routes',
      json('POST', { ...validCreate, extraDirectives: 'request_header -X-API-KEY' }),
    );
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ detail: expect.stringMatching(/admin role/) });

    const admin = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));
    const tooLong = await admin.request(
      `/api/v1/routes/${routeId}`,
      json('PATCH', { extraDirectives: `respond "${'é'.repeat(2100)}"` }),
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({
      errors: [{ path: 'body.extraDirectives', message: 'Must be at most 4096 bytes' }],
    });
  });
});
