import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@slipway/contracts';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/** Session tokens: 32 random bytes, base64url (43 characters). Only the SHA-256 is stored. */
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The session token of the request, when present and well-formed. */
export function readSessionCookie(c: Context): string | null {
  const value = getCookie(c, SESSION_COOKIE_NAME);
  return value && SESSION_TOKEN_PATTERN.test(value) ? value : null;
}

/** True when the request is served over HTTPS (directly or behind the TLS-terminating edge). */
function isHttps(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwarded === 'https' || new URL(c.req.url).protocol === 'https:';
}

/** HttpOnly, SameSite=Lax, Secure over HTTPS, 30-day Max-Age (refreshed as the session slides). */
export function writeSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/', secure: isHttps(c), httpOnly: true });
}
