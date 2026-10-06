import { generateId } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { assertCanInvite, assertCanManageUser } from './rules.js';

const owner = { id: generateId('user'), role: 'owner' as const };
const admin = { id: generateId('user'), role: 'admin' as const };
const otherAdmin = { id: generateId('user'), role: 'admin' as const };
const member = { id: generateId('user'), role: 'member' as const };
const viewer = { id: generateId('user'), role: 'viewer' as const };

describe('assertCanManageUser', () => {
  it('lets admins manage members and viewers', () => {
    expect(() =>
      assertCanManageUser(admin, member, { kind: 'update', role: 'viewer' }),
    ).not.toThrow();
    expect(() => assertCanManageUser(admin, viewer, { kind: 'update', name: 'X' })).not.toThrow();
    expect(() => assertCanManageUser(admin, member, { kind: 'delete' })).not.toThrow();
  });

  it('reserves admin management for the owner', () => {
    expect(() => assertCanManageUser(admin, member, { kind: 'update', role: 'admin' })).toThrow(
      /owner/,
    );
    expect(() => assertCanManageUser(admin, otherAdmin, { kind: 'delete' })).toThrow(/owner/);
    expect(() => assertCanManageUser(admin, admin, { kind: 'update', role: 'member' })).toThrow(
      /owner/,
    );
    expect(() =>
      assertCanManageUser(owner, member, { kind: 'update', role: 'admin' }),
    ).not.toThrow();
    expect(() =>
      assertCanManageUser(owner, admin, { kind: 'update', role: 'viewer' }),
    ).not.toThrow();
    expect(() => assertCanManageUser(owner, admin, { kind: 'delete' })).not.toThrow();
  });

  it('protects the owner', () => {
    expect(() => assertCanManageUser(owner, owner, { kind: 'delete' })).toThrow(
      /cannot be deleted/,
    );
    expect(() => assertCanManageUser(owner, owner, { kind: 'update', role: 'admin' })).toThrow(
      /cannot be demoted/,
    );
    expect(() => assertCanManageUser(admin, owner, { kind: 'update', name: 'X' })).toThrow();
    expect(() => assertCanManageUser(owner, owner, { kind: 'update', name: 'X' })).not.toThrow();
  });

  it('rejects members and viewers', () => {
    expect(() => assertCanManageUser(member, viewer, { kind: 'delete' })).toThrow();
  });
});

describe('assertCanInvite', () => {
  it('caps invitation roles by the inviter role', () => {
    expect(() => assertCanInvite('admin', 'member')).not.toThrow();
    expect(() => assertCanInvite('admin', 'admin')).toThrow(/owner/);
    expect(() => assertCanInvite('owner', 'admin')).not.toThrow();
    expect(() => assertCanInvite('member', 'viewer')).toThrow();
  });
});
