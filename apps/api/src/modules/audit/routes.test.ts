import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';
import type { Principal } from '../../lib/auth-context.js';

const appFor = (principal: Principal | null) =>
  createApp(createTestDeps({ auth: fixedAuth(principal) }));

describe('audit routes (authorization and validation)', () => {
  it('requires authentication (401) and the admin role (403)', async () => {
    expect((await appFor(null).request('/api/v1/audit')).status).toBe(401);
    expect((await appFor(testPrincipal('member')).request('/api/v1/audit')).status).toBe(403);
  });

  it('validates filters (400)', async () => {
    const app = appFor(testPrincipal('admin'));
    for (const query of ['since=yesterday', 'until=2026-13-01', 'limit=101', 'cursor=%2F']) {
      expect((await app.request(`/api/v1/audit?${query}`)).status, query).toBe(400);
    }
  });
});
