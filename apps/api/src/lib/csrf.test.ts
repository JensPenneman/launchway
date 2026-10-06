import { SESSION_COOKIE_NAME } from '@slipway/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../test/support/deps.js';
import { createApp } from '../app.js';
import type { AppEnv, Deps } from '../deps.js';
import {
  type CsrfInput,
  createPlatformOriginResolver,
  csrfDecision,
  originAllowed,
  type PlatformOriginResolver,
} from './csrf.js';

const base: CsrfInput = {
  method: 'POST',
  principalKind: 'session',
  hasSessionCookie: true,
  secFetchSite: undefined,
  origin: undefined,
};

describe('csrfDecision', () => {
  it('lets safe methods and bearer requests through', () => {
    expect(csrfDecision({ ...base, method: 'GET' })).toBe('allow');
    expect(csrfDecision({ ...base, method: 'head' })).toBe('allow');
    expect(csrfDecision({ ...base, principalKind: 'token', secFetchSite: 'cross-site' })).toBe(
      'allow',
    );
  });

  it('requires a same-origin signal for cookie-authenticated mutations', () => {
    expect(csrfDecision(base)).toBe('deny');
    expect(csrfDecision({ ...base, secFetchSite: 'same-origin' })).toBe('allow');
    expect(csrfDecision({ ...base, secFetchSite: 'none' })).toBe('allow');
    expect(csrfDecision({ ...base, secFetchSite: 'same-site' })).toBe('deny');
    expect(
      csrfDecision({ ...base, secFetchSite: 'cross-site', origin: 'https://evil.example' }),
    ).toBe('check-origin');
    expect(csrfDecision({ ...base, origin: 'https://deploy.example.com' })).toBe('check-origin');
    expect(csrfDecision({ ...base, origin: 'null' })).toBe('deny');
  });

  it('checks anonymous browser requests (login CSRF) but not plain API clients', () => {
    const anonymous = { ...base, principalKind: null, hasSessionCookie: false } as const;
    expect(csrfDecision(anonymous)).toBe('allow');
    expect(csrfDecision({ ...anonymous, secFetchSite: 'cross-site' })).toBe('deny');
    expect(csrfDecision({ ...anonymous, origin: 'https://evil.example' })).toBe('check-origin');
  });

  it('treats a session principal without the cookie (tests, internal callers) as non-browser', () => {
    expect(csrfDecision({ ...base, hasSessionCookie: false })).toBe('allow');
  });
});

describe('originAllowed', () => {
  it('compares scheme, host and port', () => {
    const platform = 'https://deploy.example.com';
    expect(originAllowed('https://deploy.example.com', platform)).toBe(true);
    expect(originAllowed('http://deploy.example.com', platform)).toBe(false);
    expect(originAllowed('https://deploy.example.com:8443', platform)).toBe(false);
    expect(originAllowed('https://app.example.com', platform)).toBe(false);
    expect(originAllowed('not a url', platform)).toBe(false);
  });
});

describe('csrfProtection middleware', () => {
  const deps = () => {
    const d = createTestDeps({ auth: fixedAuth(testPrincipal('admin')) });
    return { ...d, config: { ...d.config, publicUrl: 'https://deploy.example.com' } };
  };
  const patch = (headers: Record<string, string>) => ({
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${'a'.repeat(43)}`,
      ...headers,
    },
    body: JSON.stringify({ publicUrl: 'ftp://invalid' }),
  });

  it('rejects a cookie-authenticated cross-site mutation with 403', async () => {
    const app = createApp(deps());
    const res = await app.request('/api/v1/settings', patch({ origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      type: 'forbidden',
      detail: 'Cross-site request rejected',
    });
  });

  it('rejects a cookie-authenticated mutation without Origin or Sec-Fetch-Site', async () => {
    const app = createApp(deps());
    expect((await app.request('/api/v1/settings', patch({}))).status).toBe(403);
  });

  it('accepts the platform origin and same-origin fetches (reaching validation)', async () => {
    const app = createApp(deps());
    const viaOrigin = await app.request(
      '/api/v1/settings',
      patch({ origin: 'https://deploy.example.com' }),
    );
    expect(viaOrigin.status).toBe(400);
    const viaFetchMetadata = await app.request(
      '/api/v1/settings',
      patch({ 'sec-fetch-site': 'same-origin' }),
    );
    expect(viaFetchMetadata.status).toBe(400);
  });

  it('honours Sec-Fetch-Site without a configured public URL (no database lookup)', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));
    const res = await app.request('/api/v1/settings', patch({ 'sec-fetch-site': 'same-origin' }));
    expect(res.status).toBe(400);
  });
});

describe('createPlatformOriginResolver', () => {
  /** Minimal stand-in for `db.select().from().where()` returning the settings row. */
  function fakeDb(publicUrl: string | null) {
    let reads = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            reads += 1;
            return [{ publicUrl }];
          },
        }),
      }),
    } as unknown as Deps['db'];
    return { db, reads: () => reads };
  }

  async function originOf(resolver: PlatformOriginResolver, url: string, headers = {}) {
    const app = new Hono<AppEnv>().get('*', async (c) => c.text(await resolver.forRequest(c)));
    return (await app.request(url, { headers })).text();
  }

  it('prefers SLIPWAY_PUBLIC_URL, then settings, then the request host', async () => {
    const deps = createTestDeps();
    const override = createPlatformOriginResolver({
      ...deps,
      config: { ...deps.config, publicUrl: 'https://env.example.com' },
    });
    expect(await originOf(override, 'http://localhost:3000/x')).toBe('https://env.example.com');

    const fromSettings = fakeDb('https://deploy.example.com');
    const settingsResolver = createPlatformOriginResolver({ ...deps, db: fromSettings.db });
    expect(await originOf(settingsResolver, 'http://localhost:3000/x')).toBe(
      'https://deploy.example.com',
    );
    await originOf(settingsResolver, 'http://localhost:3000/x');
    expect(fromSettings.reads()).toBe(1);
    deps.events.publish({ topic: 'settings', action: 'updated', resourceId: null });
    await originOf(settingsResolver, 'http://localhost:3000/x');
    expect(fromSettings.reads()).toBe(2);

    const unset = createPlatformOriginResolver({ ...deps, db: fakeDb(null).db });
    expect(await originOf(unset, 'http://192.168.1.5:3000/x')).toBe('http://192.168.1.5:3000');
    expect(
      await originOf(unset, 'http://192.168.1.5:3000/x', { 'x-forwarded-proto': 'https' }),
    ).toBe('https://192.168.1.5:3000');
  });
});
