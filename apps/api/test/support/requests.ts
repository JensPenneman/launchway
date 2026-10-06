import { generateId, type TokenScope, type UserRole } from '@slipway/contracts';
import type { Principal } from '../../src/lib/auth-context.js';
import { testPrincipal } from './deps.js';

/** A bearer-token principal of a user with `role`, limited to `scopes`. */
export function tokenPrincipal(role: UserRole, scopes: TokenScope[]): Principal {
  return { kind: 'token', user: testPrincipal(role).user, tokenId: generateId('tok'), scopes };
}

/** JSON request init for `app.request(path, init)`. */
export function jsonRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
