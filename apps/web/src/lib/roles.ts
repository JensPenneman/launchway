import { lowerRole, type Me, roleAtLeast, scopeCeiling, type UserRole } from '@launchway/contracts';

/** Role the API enforces for this principal (tokens are capped by their scopes). */
export function effectiveRole(me: Pick<Me, 'user' | 'scopes'>): UserRole {
  return me.scopes ? lowerRole(me.user.role, scopeCeiling(me.scopes)) : me.user.role;
}

/** Whether the principal may perform actions that need at least `minimum`. */
export function can(me: Pick<Me, 'user' | 'scopes'> | undefined, minimum: UserRole): boolean {
  return me !== undefined && roleAtLeast(effectiveRole(me), minimum);
}
