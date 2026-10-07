import { lowerRole, scopeCeiling } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { effectiveRole } from '../../lib/auth-context.js';
import { scopesBeyondRole } from './rules.js';

describe('token scopes', () => {
  it('caps new token scopes by the creator role', () => {
    expect(scopesBeyondRole('viewer', ['read'])).toEqual([]);
    expect(scopesBeyondRole('viewer', ['read', 'write'])).toEqual(['write']);
    expect(scopesBeyondRole('member', ['write', 'admin'])).toEqual(['admin']);
    expect(scopesBeyondRole('admin', ['read', 'write', 'admin'])).toEqual([]);
  });

  it('maps scopes to a role ceiling (widest scope wins)', () => {
    expect(scopeCeiling(['read'])).toBe('viewer');
    expect(scopeCeiling(['read', 'write'])).toBe('member');
    expect(scopeCeiling(['admin'])).toBe('owner');
    expect(lowerRole('admin', scopeCeiling(['admin']))).toBe('admin');
  });

  it('computes the effective role of a token principal', () => {
    const user = { id: 'user_01ja53wvjvfk1sp7hz5965tvkz', email: 'a@x.io', name: 'A' } as const;
    const tokenId = 'tok_01ja53wvjvfk1sp7hz5965tvkz' as const;
    expect(
      effectiveRole({
        kind: 'token',
        tokenId,
        scopes: ['write'],
        user: { ...user, role: 'owner' },
      }),
    ).toBe('member');
    expect(
      effectiveRole({
        kind: 'token',
        tokenId,
        scopes: ['admin'],
        user: { ...user, role: 'member' },
      }),
    ).toBe('member');
  });
});
