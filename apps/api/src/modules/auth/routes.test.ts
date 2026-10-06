import { generateId, SESSION_COOKIE_NAME } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { jsonRequest, tokenPrincipal } from '../../../test/support/requests.js';
import { createApp } from '../../app.js';
import type { Principal } from '../../lib/auth-context.js';

function appFor(principal: Principal | null) {
  const deps = createTestDeps({ auth: fixedAuth(principal) });
  return createApp({
    ...deps,
    config: { ...deps.config, publicUrl: 'https://deploy.example.com' },
  });
}

const credential = { id: 'abc', rawId: 'abc', type: 'public-key', response: {} };

describe('auth routes (authorization and validation)', () => {
  it('rejects anonymous callers on every account route with 401', async () => {
    const app = appFor(null);
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/me', jsonRequest('GET')],
      ['/api/v1/me', jsonRequest('PATCH', { name: 'X' })],
      ['/api/v1/me/password', jsonRequest('POST', { newPassword: 'a-long-password' })],
      ['/api/v1/me/sessions', jsonRequest('GET')],
      [`/api/v1/me/sessions/${generateId('sess')}`, jsonRequest('DELETE')],
      ['/api/v1/me/passkeys', jsonRequest('GET')],
      [`/api/v1/me/passkeys/${generateId('pk')}`, jsonRequest('PATCH', { name: 'X' })],
      [`/api/v1/me/passkeys/${generateId('pk')}`, jsonRequest('DELETE')],
      ['/api/v1/auth/passkeys/register/options', jsonRequest('POST')],
      ['/api/v1/auth/passkeys/register/verify', jsonRequest('POST', { credential })],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(401);
    }
  });

  it('reserves account changes and passkey registration for sessions (403 for tokens)', async () => {
    const app = appFor(tokenPrincipal('owner', ['admin']));
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/me', jsonRequest('PATCH', { name: 'X' })],
      ['/api/v1/me/password', jsonRequest('POST', { newPassword: 'a-long-password' })],
      [`/api/v1/me/sessions/${generateId('sess')}`, jsonRequest('DELETE')],
      ['/api/v1/auth/passkeys/register/options', jsonRequest('POST')],
      ['/api/v1/auth/passkeys/register/verify', jsonRequest('POST', { credential })],
      [`/api/v1/me/passkeys/${generateId('pk')}`, jsonRequest('PATCH', { name: 'X' })],
      [`/api/v1/me/passkeys/${generateId('pk')}`, jsonRequest('DELETE')],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(403);
    }
  });

  it('validates bodies and path parameters with 400', async () => {
    const app = appFor(testPrincipal('member'));
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/setup', jsonRequest('POST', { email: 'x', name: '', password: 'short' })],
      ['/api/v1/auth/login', jsonRequest('POST', { email: 'a@example.com' })],
      ['/api/v1/me', jsonRequest('PATCH', {})],
      ['/api/v1/me/password', jsonRequest('POST', { newPassword: 'short' })],
      ['/api/v1/me/sessions/not-an-id', jsonRequest('DELETE')],
      ['/api/v1/me/passkeys/not-an-id', jsonRequest('DELETE')],
      [`/api/v1/me/passkeys/${generateId('pk')}`, jsonRequest('PATCH', { name: '' })],
      ['/api/v1/auth/passkeys/register/verify', jsonRequest('POST', { credential: {} })],
      ['/api/v1/auth/passkeys/login/verify', jsonRequest('POST', {})],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(400);
      expect(await res.json()).toMatchObject({ type: 'validation-failed' });
    }
  });

  it('signs out idempotently and clears the cookie', async () => {
    const res = await appFor(null).request('/api/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it('returns passkey sign-in options for the platform origin without allowCredentials', async () => {
    const res = await appFor(null).request('/api/v1/auth/passkeys/login/options', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const options = (await res.json()) as Record<string, unknown>;
    expect(options).toMatchObject({ rpId: 'deploy.example.com', userVerification: 'required' });
    expect(typeof options.challenge).toBe('string');
    expect(options.allowCredentials ?? []).toEqual([]);
  });
});
