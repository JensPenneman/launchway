import {
  API_TOKEN_PATTERN,
  NODE_CREDENTIAL_PREFIX,
  NODE_JOIN_TOKEN_PREFIX,
  SESSION_TTL_SECONDS,
} from '@slipway/contracts';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv, Deps } from '../../deps.js';
import type { AuthResolver, AuthUser, Principal } from '../../lib/auth-context.js';
import { hashToken } from '../../lib/crypto.js';
import { unauthorized } from '../../lib/problem.js';
import { apiTokens } from '../tokens/schema.js';
import { users } from '../users/schema.js';
import { sessions } from './schema.js';
import { clearSessionCookie, readSessionCookie, writeSessionCookie } from './session-cookie.js';

/** Minimum interval between `last_used_at` writes (and sliding-expiry extensions). */
export const TOUCH_INTERVAL_MS = 60_000;

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

function isAgentToken(header: string): boolean {
  const token = BEARER.exec(header)?.[1];
  return (
    token !== undefined &&
    (token.startsWith(NODE_JOIN_TOKEN_PREFIX) || token.startsWith(NODE_CREDENTIAL_PREFIX))
  );
}

const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role };

export interface AuthResolverOptions {
  /** Clock for tests. */
  readonly now?: () => Date;
}

/**
 * The real `Deps.auth`: resolves the caller from `Authorization: Bearer slp_...` (takes
 * precedence) or the `slipway_session` cookie.
 * - Bearer: hashed lookup in `api_tokens`; unknown, malformed or expired tokens are a 401.
 * - Cookie: hashed lookup in `sessions`; unknown or expired sessions make the request anonymous
 *   (and clear the cookie) so that sign-in and setup keep working with a stale cookie.
 * Both touch `last_used_at` at most once per minute; sessions then also slide their 30-day expiry
 * and refresh the cookie.
 */
export function createAuthResolver(
  deps: Pick<Deps, 'db' | 'logger'>,
  options: AuthResolverOptions = {},
): AuthResolver {
  const now = options.now ?? (() => new Date());

  async function fromToken(c: Context<AppEnv>, header: string): Promise<Principal> {
    const token = BEARER.exec(header)?.[1];
    if (!token || !API_TOKEN_PATTERN.test(token)) {
      throw unauthorized('Malformed Authorization header; expected Bearer slp_...');
    }
    const [row] = await deps.db
      .select({
        id: apiTokens.id,
        scopes: apiTokens.scopes,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
        user: userColumns,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.tokenHash, hashToken(token)));
    const at = now();
    if (!row) throw unauthorized('Invalid API token');
    if (row.expiresAt && row.expiresAt <= at) throw unauthorized('The API token has expired');

    if (!row.lastUsedAt || at.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      await deps.db
        .update(apiTokens)
        .set({ lastUsedAt: at })
        .where(eq(apiTokens.id, row.id))
        .catch((err: unknown) => c.get('logger')?.warn({ err }, 'failed to touch API token'));
    }
    return {
      kind: 'token',
      user: row.user satisfies AuthUser,
      tokenId: row.id,
      scopes: row.scopes,
    };
  }

  async function fromSession(c: Context<AppEnv>, token: string): Promise<Principal | null> {
    const at = now();
    const [row] = await deps.db
      .select({ id: sessions.id, lastUsedAt: sessions.lastUsedAt, user: userColumns })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, at)));
    if (!row) {
      clearSessionCookie(c);
      return null;
    }

    if (at.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      try {
        const touched = await deps.db
          .update(sessions)
          .set({
            lastUsedAt: at,
            expiresAt: new Date(at.getTime() + SESSION_TTL_SECONDS * 1000),
            ipAddress: c.get('clientIp'),
            userAgent: c.req.header('user-agent')?.slice(0, 512) ?? null,
          })
          .where(
            and(
              eq(sessions.id, row.id),
              lt(sessions.lastUsedAt, new Date(at.getTime() - TOUCH_INTERVAL_MS + 1)),
            ),
          )
          .returning({ id: sessions.id });
        if (touched.length > 0) writeSessionCookie(c, token);
      } catch (err) {
        c.get('logger')?.warn({ err }, 'failed to extend session');
      }
    }
    return { kind: 'session', user: row.user, sessionId: row.id };
  }

  return {
    async resolve(c) {
      const authorization = c.req.header('authorization');
      // Join tokens and node credentials authenticate the agent socket, which checks them
      // itself; for the REST API such a request is anonymous.
      if (authorization !== undefined && isAgentToken(authorization)) return null;
      if (authorization !== undefined) return fromToken(c, authorization);
      const token = readSessionCookie(c);
      return token ? fromSession(c, token) : null;
    },
  };
}
