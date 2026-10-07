import { generateId, SESSION_COOKIE_NAME } from '@launchway/contracts';
import { Hono } from 'hono';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppEnv, Deps } from '../../deps.js';
import { generateToken } from '../../lib/crypto.js';
import { toProblem } from '../../lib/problem.js';
import { createAuthResolver, TOUCH_INTERVAL_MS } from './resolver.js';
import { generateSessionToken } from './session-cookie.js';

/**
 * Stand-in for the Drizzle query builder: every chain (`select().from()...`, `update().set()...`)
 * resolves to the next scripted result. Records which statements ran.
 */
function scriptedDb(results: unknown[][]) {
  const statements: string[] = [];
  const next = () => Promise.resolve(results.shift() ?? []);
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') return (ok: never, fail: never) => next().then(ok, fail);
        if (prop === 'catch') return (fail: never) => next().catch(fail);
        return () => chain();
      },
    });
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          statements.push(String(prop));
          return chain();
        };
      },
    },
  ) as Deps['db'];
  return { db, statements };
}

const NOW = new Date('2026-10-07T12:00:00.000Z');
const user = { id: generateId('user'), email: 'a@example.com', name: 'A', role: 'admin' as const };

async function resolveWith(db: Deps['db'], headers: Record<string, string> = {}) {
  const resolver = createAuthResolver(
    { db, logger: pino({ level: 'silent' }) },
    { now: () => NOW },
  );
  const app = new Hono<AppEnv>().get('/', async (c) => {
    try {
      return c.json({ principal: await resolver.resolve(c) });
    } catch (error) {
      return c.json({ problem: toProblem(error).problem });
    }
  });
  const res = await app.request('/', { headers });
  return {
    body: (await res.json()) as { principal?: unknown; problem?: { type: string } },
    setCookie: res.headers.get('set-cookie'),
  };
}

describe('createAuthResolver', () => {
  it('treats requests without credentials as anonymous, without touching the database', async () => {
    const { db, statements } = scriptedDb([]);
    expect((await resolveWith(db)).body).toEqual({ principal: null });
    expect(statements).toEqual([]);
  });

  it('rejects malformed Authorization headers with 401', async () => {
    for (const header of [
      'Basic abc',
      'Bearer',
      'Bearer lwy_short',
      `Token ${generateToken('lwy_')}`,
    ]) {
      const { db } = scriptedDb([]);
      expect((await resolveWith(db, { authorization: header })).body.problem?.type).toBe(
        'unauthorized',
      );
    }
  });

  it('leaves join tokens and node credentials to the agent socket (anonymous, no lookup)', async () => {
    for (const prefix of ['lwyn_', 'lwya_'] as const) {
      const { db, statements } = scriptedDb([]);
      const { body } = await resolveWith(db, { authorization: `Bearer ${generateToken(prefix)}` });
      expect(body).toEqual({ principal: null });
      expect(statements).toEqual([]);
    }
  });

  it('resolves a bearer token, keeping its scopes, and touches last_used_at', async () => {
    const tokenId = generateId('tok');
    const { db, statements } = scriptedDb([
      [{ id: tokenId, scopes: ['read'], expiresAt: null, lastUsedAt: null, user }],
      [],
    ]);
    const { body } = await resolveWith(db, { authorization: `Bearer ${generateToken('lwy_')}` });
    expect(body.principal).toEqual({ kind: 'token', user, tokenId, scopes: ['read'] });
    expect(statements).toEqual(['select', 'update']);
  });

  it('does not touch a token used within the last minute', async () => {
    const recent = new Date(NOW.getTime() - TOUCH_INTERVAL_MS / 2);
    const { db, statements } = scriptedDb([
      [{ id: generateId('tok'), scopes: ['write'], expiresAt: null, lastUsedAt: recent, user }],
    ]);
    await resolveWith(db, { authorization: `bearer ${generateToken('lwy_')}` });
    expect(statements).toEqual(['select']);
  });

  it('rejects unknown and expired tokens with 401', async () => {
    const unknown = scriptedDb([[]]);
    expect(
      (await resolveWith(unknown.db, { authorization: `Bearer ${generateToken('lwy_')}` })).body
        .problem?.type,
    ).toBe('unauthorized');
    const expired = scriptedDb([
      [{ id: generateId('tok'), scopes: ['admin'], expiresAt: NOW, lastUsedAt: null, user }],
    ]);
    expect(
      (await resolveWith(expired.db, { authorization: `Bearer ${generateToken('lwy_')}` })).body
        .problem?.type,
    ).toBe('unauthorized');
  });

  it('resolves a session cookie without rewriting a recently used session', async () => {
    const sessionId = generateId('sess');
    const { db, statements } = scriptedDb([[{ id: sessionId, lastUsedAt: NOW, user }]]);
    const { body, setCookie } = await resolveWith(db, {
      cookie: `${SESSION_COOKIE_NAME}=${generateSessionToken()}`,
    });
    expect(body.principal).toEqual({ kind: 'session', user, sessionId });
    expect(statements).toEqual(['select']);
    expect(setCookie).toBeNull();
  });

  it('slides the expiry of a session idle for over a minute and refreshes the cookie', async () => {
    const sessionId = generateId('sess');
    const idle = new Date(NOW.getTime() - TOUCH_INTERVAL_MS);
    const { db, statements } = scriptedDb([
      [{ id: sessionId, lastUsedAt: idle, user }],
      [{ id: sessionId }],
    ]);
    const token = generateSessionToken();
    const { setCookie } = await resolveWith(db, { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    expect(statements).toEqual(['select', 'update']);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000');
  });

  it('makes unknown or expired sessions anonymous and clears the cookie', async () => {
    const { db } = scriptedDb([[]]);
    const { body, setCookie } = await resolveWith(db, {
      cookie: `${SESSION_COOKIE_NAME}=${generateSessionToken()}`,
    });
    expect(body).toEqual({ principal: null });
    expect(setCookie).toContain('Max-Age=0');
  });

  it('ignores malformed session cookies', async () => {
    const { db, statements } = scriptedDb([]);
    const { body } = await resolveWith(db, { cookie: `${SESSION_COOKIE_NAME}=nope` });
    expect(body).toEqual({ principal: null });
    expect(statements).toEqual([]);
  });

  it('prefers the bearer token over the session cookie', async () => {
    const tokenId = generateId('tok');
    const { db } = scriptedDb([
      [{ id: tokenId, scopes: ['read'], expiresAt: null, lastUsedAt: NOW, user }],
    ]);
    const { body } = await resolveWith(db, {
      authorization: `Bearer ${generateToken('lwy_')}`,
      cookie: `${SESSION_COOKIE_NAME}=${generateSessionToken()}`,
    });
    expect(body.principal).toMatchObject({ kind: 'token', tokenId });
  });
});
