import { generateId } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { jsonRequest, tokenPrincipal } from '../../../test/support/requests.js';
import { createApp } from '../../app.js';
import type { Principal } from '../../lib/auth-context.js';

const appFor = (principal: Principal | null) =>
  createApp(createTestDeps({ auth: fixedAuth(principal) }));
const userPath = `/api/v1/users/${generateId('user')}`;

describe('users routes (authorization and validation)', () => {
  it('requires authentication (401) and the admin role (403)', async () => {
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/users', jsonRequest('GET')],
      [userPath, jsonRequest('GET')],
      [userPath, jsonRequest('PATCH', { name: 'X' })],
      [userPath, jsonRequest('DELETE')],
    ];
    for (const [path, init] of calls) {
      expect((await appFor(null).request(path, init)).status).toBe(401);
      expect((await appFor(testPrincipal('member')).request(path, init)).status).toBe(403);
      // An owner's write-scoped token acts as a member.
      expect((await appFor(tokenPrincipal('owner', ['write'])).request(path, init)).status).toBe(
        403,
      );
    }
  });

  it('validates queries, ids and bodies (400)', async () => {
    const app = appFor(testPrincipal('admin'));
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/users?limit=0', jsonRequest('GET')],
      ['/api/v1/users?cursor=***', jsonRequest('GET')],
      ['/api/v1/users/nope', jsonRequest('GET')],
      [userPath, jsonRequest('PATCH', {})],
      [userPath, jsonRequest('PATCH', { role: 'owner' })],
      ['/api/v1/users/nope', jsonRequest('DELETE')],
    ];
    for (const [path, init] of calls) {
      expect((await app.request(path, init)).status, `${init.method} ${path}`).toBe(400);
    }
  });
});
