import {
  type ApiTokenId,
  type AuditActor,
  lowerRole,
  roleAtLeast,
  type SessionId,
  scopeCeiling,
  type TokenScope,
  type UserId,
  type UserRole,
} from '@slipway/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../deps.js';
import { forbidden, unauthorized } from './problem.js';

export interface AuthUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
}

/** The authenticated caller of a request. */
export type Principal =
  | { readonly kind: 'session'; readonly user: AuthUser; readonly sessionId: SessionId }
  | {
      readonly kind: 'token';
      readonly user: AuthUser;
      readonly tokenId: ApiTokenId;
      readonly scopes: readonly TokenScope[];
    };

/**
 * Resolves the caller of a request. TODO(auth): the auth module provides the real
 * implementation and wires it into `Deps.auth` in src/server.ts:
 * - cookie `slipway_session`: look up the SHA-256 hash of the cookie value, check expiry, extend
 *   the 30-day sliding window; for unsafe methods enforce CSRF (Origin / Sec-Fetch-Site must
 *   match the platform origin);
 * - `Authorization: Bearer slp_...`: look up the hashed token, check expiry, touch lastUsedAt.
 * Return null for anonymous requests; throw `unauthorized()` for invalid or expired credentials.
 */
export interface AuthResolver {
  resolve(c: Context<AppEnv>): Promise<Principal | null>;
}

/** Placeholder until the auth module lands: every request is anonymous. */
export const anonymousAuthResolver: AuthResolver = {
  resolve: () => Promise.resolve(null),
};

/** Role a principal acts with: tokens are capped by their scopes (read/write/admin). */
export function effectiveRole(principal: Principal): UserRole {
  return principal.kind === 'token'
    ? lowerRole(principal.user.role, scopeCeiling(principal.scopes))
    : principal.user.role;
}

/** Global middleware: resolves the principal once per request into `c.var.principal`. */
export function authenticate(resolver: AuthResolver): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('principal', await resolver.resolve(c));
    await next();
  };
}

/**
 * Per-route authorization (declare it in `createRoute({ middleware: [requireRole('member')] })`):
 * 401 for anonymous callers, 403 when the effective role is below `minimum`.
 */
export function requireRole(minimum: UserRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw unauthorized();
    if (!roleAtLeast(effectiveRole(principal), minimum)) {
      throw forbidden(`This action requires the ${minimum} role`);
    }
    await next();
  };
}

/**
 * The principal of a request behind `requireRole()`; throws 401 when anonymous.
 * @public
 */
export function getPrincipal(c: Context<AppEnv>): Principal {
  const principal = c.get('principal');
  if (!principal) throw unauthorized();
  return principal;
}

/** Who performed an action and from where; passed to services for audit events. */
export interface RequestActor {
  readonly principal: Principal | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  /** Overrides the actor derived from `principal` (e.g. an agent or a background job). */
  readonly actor?: AuditActor;
}

export function requestActor(c: Context<AppEnv>): RequestActor {
  return {
    principal: c.get('principal'),
    ipAddress: c.get('clientIp'),
    userAgent: c.req.header('user-agent')?.slice(0, 512) ?? null,
    requestId: c.get('requestId'),
  };
}

/**
 * Actor for work not triggered by a request (schedulers, startup tasks).
 * @public
 */
export function systemActor(label: string): RequestActor {
  return {
    principal: null,
    ipAddress: null,
    userAgent: null,
    requestId: `system:${label}`,
    actor: { type: 'system', id: null, label },
  };
}

/** Audit actor of a request. */
export function auditActorOf(actor: RequestActor): AuditActor {
  if (actor.actor) return actor.actor;
  const principal = actor.principal;
  if (!principal) return { type: 'system', id: null, label: null };
  if (principal.kind === 'token') {
    return { type: 'token', id: principal.tokenId, label: principal.user.email };
  }
  return { type: 'user', id: principal.user.id, label: principal.user.email };
}
