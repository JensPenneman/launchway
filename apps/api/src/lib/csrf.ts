import { SESSION_COOKIE_NAME } from '@launchway/contracts';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, Deps } from '../deps.js';
import { settings } from '../modules/settings/schema.js';
import { forbidden } from './problem.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'none']);
const CACHE_TTL_MS = 30_000;

/**
 * The origin the platform is served from: `LAUNCHWAY_PUBLIC_URL`, else `settings.public_url`, else
 * null (callers then fall back to the request's own host). Cached briefly and refreshed when the
 * settings change.
 */
export interface PlatformOriginResolver {
  configured(): Promise<string | null>;
  /** The configured origin, or the origin of the request (Host header) before setup. */
  forRequest(c: Context<AppEnv>): Promise<string>;
}

export function createPlatformOriginResolver(
  deps: Pick<Deps, 'config' | 'db' | 'events' | 'logger'>,
): PlatformOriginResolver {
  let cached: { value: string | null; at: number } | undefined;
  deps.events.subscribe((event) => {
    if (event.topic === 'settings') cached = undefined;
  });

  async function configured(): Promise<string | null> {
    if (deps.config.publicUrl) return deps.config.publicUrl;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const [row] = await deps.db
      .select({ publicUrl: settings.publicUrl })
      .from(settings)
      .where(eq(settings.id, 1));
    const value = row?.publicUrl ? new URL(row.publicUrl).origin : null;
    cached = { value, at: Date.now() };
    return value;
  }

  return {
    configured,
    async forRequest(c) {
      return (await configured()) ?? requestOrigin(c);
    },
  };
}

/** Origin of the request as the client addressed it (Host header; https behind a TLS proxy). */
export function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : null;
  const host = c.req.header('host') ?? url.host;
  return `${protocol ?? url.protocol.replace(':', '')}://${host}`;
}

export interface CsrfInput {
  readonly method: string;
  /** Kind of the resolved principal (null = anonymous). */
  readonly principalKind: 'session' | 'token' | null;
  /** The request carries the session cookie (the browser attached it automatically). */
  readonly hasSessionCookie: boolean;
  readonly secFetchSite: string | undefined;
  readonly origin: string | undefined;
}

/**
 * CSRF decision for one request (spec section 7):
 * - safe methods and bearer-token requests pass;
 * - cookie-authenticated unsafe requests must carry `Sec-Fetch-Site: same-origin|none` or an
 *   `Origin` equal to the platform origin;
 * - anonymous unsafe requests from a browser (Origin or Sec-Fetch-Site present) are checked the
 *   same way, which blocks login CSRF; non-browser clients (curl, webhooks) send neither and pass.
 * `check-origin` means the answer depends on the platform origin (see `originAllowed`).
 */
export function csrfDecision(input: CsrfInput): 'allow' | 'deny' | 'check-origin' {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return 'allow';
  if (input.principalKind === 'token') return 'allow';
  const cookieAuthenticated = input.principalKind === 'session' && input.hasSessionCookie;
  const fromBrowser = input.origin !== undefined || input.secFetchSite !== undefined;
  if (!cookieAuthenticated && !fromBrowser) return 'allow';
  if (input.secFetchSite && TRUSTED_FETCH_SITES.has(input.secFetchSite.toLowerCase())) {
    return 'allow';
  }
  if (!input.origin || input.origin === 'null') return 'deny';
  return 'check-origin';
}

/** True when the `Origin` header names the platform origin (scheme, host and port). */
export function originAllowed(origin: string, platformOrigin: string): boolean {
  try {
    return new URL(origin).origin === new URL(platformOrigin).origin;
  } catch {
    return false;
  }
}

/** Global middleware after `authenticate()`: rejects cross-site state-changing requests (403). */
export function csrfProtection(origins: PlatformOriginResolver): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('origin');
    const decision = csrfDecision({
      method: c.req.method,
      principalKind: c.get('principal')?.kind ?? null,
      hasSessionCookie: getCookie(c, SESSION_COOKIE_NAME) !== undefined,
      secFetchSite: c.req.header('sec-fetch-site'),
      origin,
    });
    if (
      decision === 'deny' ||
      (decision === 'check-origin' && !originAllowed(origin ?? '', await origins.forRequest(c)))
    ) {
      c.get('logger')?.warn('cross-site request rejected');
      throw forbidden('Cross-site request rejected');
    }
    await next();
  };
}
