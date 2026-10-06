import { DisplayName, Email, Timestamp } from './common.js';
import { UserId } from './ids.js';
import { page } from './pagination.js';
import { z } from './zod.js';

/** Roles from most to least privileged (spec section 7). */
export const USER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const UserRole = z.enum(USER_ROLES).openapi('UserRole', {
  description:
    'owner: everything, cannot be removed; admin: everything except managing owners; member: apps, deployments, domains; viewer: read-only',
});
export type UserRole = z.infer<typeof UserRole>;

/** Roles that can be granted through invitations or role changes (there is exactly one owner). */
export const AssignableRole = UserRole.exclude(['owner']).openapi('AssignableRole');
export type AssignableRole = z.infer<typeof AssignableRole>;

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** True when `role` grants at least the permissions of `minimum`. */
export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** The less privileged of two roles. */
export function lowerRole(a: UserRole, b: UserRole): UserRole {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

export const UserSummary = z
  .object({ id: UserId, name: DisplayName, email: Email })
  .openapi('UserSummary');
export type UserSummary = z.infer<typeof UserSummary>;

export const User = z
  .object({
    id: UserId,
    email: Email,
    name: DisplayName,
    role: UserRole,
    hasPassword: z.boolean(),
    passkeyCount: z.number().int().min(0),
    lastLoginAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('User');
export type User = z.infer<typeof User>;

export const UserPage = page(User).openapi('UserPage');
export type UserPage = z.infer<typeof UserPage>;

export const UpdateUserInput = z
  .strictObject({
    name: DisplayName.optional(),
    role: AssignableRole.optional(),
  })
  .refine((v) => v.name !== undefined || v.role !== undefined, 'Provide at least one field')
  .openapi('UpdateUserInput');
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;
