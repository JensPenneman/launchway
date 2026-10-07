import type { Me } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { can, effectiveRole } from './roles';

function principal(role: Me['user']['role'], scopes: Me['scopes'] = null) {
  return { user: { role } as Me['user'], scopes };
}

describe('roles', () => {
  it('uses the user role for sessions', () => {
    expect(effectiveRole(principal('admin'))).toBe('admin');
    expect(can(principal('member'), 'member')).toBe(true);
    expect(can(principal('viewer'), 'member')).toBe(false);
  });

  it('caps tokens by their widest scope', () => {
    expect(effectiveRole(principal('owner', ['read']))).toBe('viewer');
    expect(effectiveRole(principal('admin', ['read', 'write']))).toBe('member');
    expect(effectiveRole(principal('member', ['admin']))).toBe('member');
  });

  it('denies everything without a principal', () => {
    expect(can(undefined, 'viewer')).toBe(false);
  });
});
