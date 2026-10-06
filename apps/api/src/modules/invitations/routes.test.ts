import { generateId } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { jsonRequest } from '../../../test/support/requests.js';
import { createApp } from '../../app.js';
import type { Principal } from '../../lib/auth-context.js';

const appFor = (principal: Principal | null) =>
  createApp(createTestDeps({ auth: fixedAuth(principal) }));
const token = `slpi_${'A'.repeat(43)}`;

describe('invitations routes (authorization and validation)', () => {
  it('requires authentication (401) and the admin role (403) for management', async () => {
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/invitations', jsonRequest('GET')],
      ['/api/v1/invitations', jsonRequest('POST', { role: 'member' })],
      [`/api/v1/invitations/${generateId('inv')}`, jsonRequest('DELETE')],
    ];
    for (const [path, init] of calls) {
      expect((await appFor(null).request(path, init)).status).toBe(401);
      expect((await appFor(testPrincipal('member')).request(path, init)).status).toBe(403);
    }
  });

  it('lets only the owner invite admins', async () => {
    const res = await appFor(testPrincipal('admin')).request(
      '/api/v1/invitations',
      jsonRequest('POST', { role: 'admin' }),
    );
    expect(res.status).toBe(403);
  });

  it('validates bodies, ids and tokens (400)', async () => {
    const admin = appFor(testPrincipal('admin'));
    const calls: [string, ReturnType<typeof jsonRequest>][] = [
      ['/api/v1/invitations', jsonRequest('POST', { role: 'owner' })],
      ['/api/v1/invitations', jsonRequest('POST', { role: 'member', expiresInHours: 0 })],
      ['/api/v1/invitations?limit=1000', jsonRequest('GET')],
      ['/api/v1/invitations/nope', jsonRequest('DELETE')],
      ['/api/v1/invitations/slpi_short', jsonRequest('GET')],
      ['/api/v1/invitations/slpi_short/accept', jsonRequest('POST', { name: 'N' })],
      [`/api/v1/invitations/${token}/accept`, jsonRequest('POST', { name: '' })],
      [
        `/api/v1/invitations/${token}/accept`,
        jsonRequest('POST', { name: 'N', password: 'short' }),
      ],
      [`/api/v1/invitations/${token}/accept`, jsonRequest('POST', { name: 'N', token })],
    ];
    for (const [path, init] of calls) {
      expect((await admin.request(path, init)).status, `${init.method} ${path}`).toBe(400);
    }
  });
});
