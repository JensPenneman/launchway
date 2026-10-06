import { TOKEN_SCOPES, type TokenScope, type UserRole } from '@slipway/contracts';

const ALLOWED_SCOPES: Record<UserRole, readonly TokenScope[]> = {
  viewer: ['read'],
  member: ['read', 'write'],
  admin: TOKEN_SCOPES,
  owner: TOKEN_SCOPES,
};

/** Scopes a user with `role` may put on a new token (a token never outranks its creator). */
export function allowedScopes(role: UserRole): readonly TokenScope[] {
  return ALLOWED_SCOPES[role];
}

/** Requested scopes the role may not grant (empty when the request is fine). */
export function scopesBeyondRole(role: UserRole, scopes: readonly TokenScope[]): TokenScope[] {
  const allowed = allowedScopes(role);
  return scopes.filter((scope) => !allowed.includes(scope));
}
