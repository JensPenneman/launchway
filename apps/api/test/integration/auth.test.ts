import { randomUUID } from 'node:crypto';
import {
  API_TOKEN_PATTERN,
  type AuditEventPage,
  type CreatedApiToken,
  type CreatedInvitation,
  type Me,
  SESSION_COOKIE_NAME,
  type SessionList,
  type UserPage,
} from '@slipway/contracts';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { apiTokens, auditEvents, passkeys, sessions, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createAuthResolver } from '../../src/modules/auth/resolver.js';
import { insertUser } from '../../src/modules/users/service.js';
import { createTestDeps } from '../support/deps.js';
import { createSoftAuthenticator } from '../support/soft-authenticator.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

type App = ReturnType<typeof createApp>;

/** A browser-ish client: keeps the session cookie and sends same-origin headers on mutations. */
class Client {
  cookie: string | null = null;
  private readonly app: App;
  private readonly extraHeaders: Record<string, string>;

  constructor(app: App, extraHeaders: Record<string, string> = {}) {
    this.app = app;
    this.extraHeaders = extraHeaders;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await this.app.request(`/api/v1${path}`, {
      method,
      headers: {
        'user-agent': 'integration-test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${this.cookie}` } : {}),
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        ...this.extraHeaders,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie?.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      const value = setCookie.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0] ?? '';
      this.cookie = value === '' ? null : value;
    }
    return res;
  }
}

const json = async <T>(res: Response) => (await res.json()) as T;
const unique = () => randomUUID().slice(0, 8);

describe('accounts and authentication against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let app: App;
  let admin: Client;
  let adminEmail: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    const deps = createTestDeps({
      db,
      auth: createAuthResolver({ db, logger: pino({ level: 'silent' }) }),
    });
    app = createApp({ ...deps, config: { ...deps.config, publicUrl: ORIGIN } });
    admin = new Client(app);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs the first-run setup once (or refuses it when users exist)', async () => {
    const status = await json<{ setupRequired: boolean }>(await admin.request('GET', '/setup'));
    adminEmail = `owner-${unique()}@example.com`;
    if (status.setupRequired) {
      const res = await admin.request('POST', '/setup', {
        email: adminEmail.toUpperCase(),
        name: 'Owner',
        password: PASSWORD,
      });
      expect(res.status).toBe(201);
      const me = await json<Me>(res);
      expect(me).toMatchObject({
        authMethod: 'session',
        user: { email: adminEmail, role: 'owner', hasPassword: true, passkeyCount: 0 },
      });
      expect(me.user).not.toHaveProperty('passwordHash');
      expect(admin.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await json(await admin.request('GET', '/setup'))).toEqual({ setupRequired: false });
    } else {
      // Another test file created users first: continue as a freshly seeded owner-level admin.
      await insertUser(db, {
        email: adminEmail,
        name: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword(PASSWORD),
      });
    }
    const again = await new Client(app).request('POST', '/setup', {
      email: `late-${unique()}@example.com`,
      name: 'Late',
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
  });

  it('signs in with a password, rotating the session, with a generic failure message', async () => {
    const wrong = await admin.request('POST', '/auth/login', { email: adminEmail, password: 'x' });
    const unknown = await new Client(app).request('POST', '/auth/login', {
      email: `nobody-${unique()}@example.com`,
      password: PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await json<{ detail: string }>(wrong)).detail).toBe(
      (await json<{ detail: string }>(unknown)).detail,
    );

    const previous = admin.cookie;
    const res = await admin.request('POST', '/auth/login', {
      email: adminEmail,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(admin.cookie).not.toBeNull();
    expect(admin.cookie).not.toBe(previous);
    if (previous) {
      // The session the request carried was ended (no fixation, no orphan).
      const stale = new Client(app);
      stale.cookie = previous;
      expect((await stale.request('GET', '/me')).status).toBe(401);
    }

    const me = await json<Me>(await admin.request('GET', '/me'));
    expect(me.authMethod).toBe('session');
    expect(me.user.lastLoginAt).not.toBeNull();
    const [failed] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'auth.login-failed'));
    expect(failed).toBeDefined();
  });

  it('blocks cross-site cookie requests but accepts same-origin ones', async () => {
    const crossSite = await admin.request(
      'PATCH',
      '/me',
      { name: 'Evil' },
      {
        origin: 'https://evil.example',
      },
    );
    expect(crossSite.status).toBe(403);
    const sameOrigin = await admin.request('PATCH', '/me', { name: 'Renamed Owner' });
    expect(sameOrigin.status).toBe(200);
    expect((await json<Me>(sameOrigin)).user.name).toBe('Renamed Owner');
  });

  it('creates an API token, authenticates with it and revokes it', async () => {
    const created = await admin.request('POST', '/tokens', { name: 'ci', scopes: ['read'] });
    expect(created.status).toBe(201);
    const { token, secret } = await json<CreatedApiToken>(created);
    expect(secret).toMatch(API_TOKEN_PATTERN);
    expect(secret.startsWith(token.tokenHint)).toBe(true);
    const [stored] = await db.select().from(apiTokens).where(eq(apiTokens.id, token.id));
    expect(stored?.tokenHash).not.toContain(secret);

    const bearer = new Client(app, { authorization: `Bearer ${secret}` });
    const me = await json<Me>(await bearer.request('GET', '/me'));
    expect(me).toMatchObject({ authMethod: 'token', tokenId: token.id, scopes: ['read'] });
    // Read scope acts as viewer: no settings changes, and no CSRF requirement for bearer calls.
    const forbidden = await bearer.request(
      'PATCH',
      '/settings',
      { dynamicDnsEnabled: true },
      {
        origin: 'https://evil.example',
      },
    );
    expect(forbidden.status).toBe(403);
    expect((await json<{ detail: string }>(forbidden)).detail).toContain('admin role');

    const list = await json<{ items: Record<string, unknown>[] }>(
      await admin.request('GET', '/tokens'),
    );
    const listed = list.items.find((item) => item.id === token.id);
    expect(listed?.lastUsedAt).not.toBeNull();
    expect(listed).not.toHaveProperty('tokenHash');

    expect((await admin.request('DELETE', `/tokens/${token.id}`)).status).toBe(204);
    expect((await bearer.request('GET', '/me')).status).toBe(401);
  });

  it('invites a member who accepts with a password and appears in the user list', async () => {
    const email = `member-${unique()}@example.com`;
    const created = await admin.request('POST', '/invitations', { role: 'member', email });
    expect(created.status).toBe(201);
    const invitation = await json<CreatedInvitation>(created);
    expect(invitation.url).toBe(`${ORIGIN}/invite#${invitation.token}`);
    expect(invitation.invitation).toMatchObject({ status: 'pending', role: 'member', email });

    const visitor = new Client(app);
    const preview = await visitor.request('GET', `/invitations/${invitation.token}`);
    expect(await json(preview)).toMatchObject({ email, role: 'member' });

    const accepted = await visitor.request('POST', `/invitations/${invitation.token}/accept`, {
      name: 'Member',
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    const me = await json<Me>(accepted);
    expect(me.user).toMatchObject({ email, role: 'member', hasPassword: true });
    expect(visitor.cookie).not.toBeNull();

    const reuse = await new Client(app).request('POST', `/invitations/${invitation.token}/accept`, {
      name: 'Again',
      password: PASSWORD,
    });
    expect(reuse.status).toBe(410);
    expect((await new Client(app).request('GET', `/invitations/${invitation.token}`)).status).toBe(
      410,
    );

    // Members cannot manage users; admins see the new member.
    expect((await visitor.request('GET', '/users')).status).toBe(403);
    const page = await json<UserPage>(await admin.request('GET', '/users?limit=100'));
    const listed = page.items.find((user) => user.id === me.user.id);
    expect(listed).toMatchObject({ role: 'member', passkeyCount: 0 });
    expect(listed).not.toHaveProperty('passwordHash');

    const updated = await admin.request('PATCH', `/users/${me.user.id}`, { role: 'viewer' });
    expect(await json(updated)).toMatchObject({ role: 'viewer' });
    // The member's own session now acts as viewer.
    expect(
      (await visitor.request('POST', '/tokens', { name: 't', scopes: ['write'] })).status,
    ).toBe(403);

    const invitations = await json<{ items: { id: string; status: string }[] }>(
      await admin.request('GET', '/invitations'),
    );
    expect(invitations.items.find((i) => i.id === invitation.invitation.id)?.status).toBe(
      'accepted',
    );

    expect((await admin.request('DELETE', `/users/${me.user.id}`)).status).toBe(204);
    expect((await visitor.request('GET', '/me')).status).toBe(401);
  });

  it('pages and filters the audit log', async () => {
    const page1 = await json<AuditEventPage>(
      await admin.request('GET', '/audit?action=invitation.&limit=1'),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await json<AuditEventPage>(
      await admin.request('GET', `/audit?action=invitation.&limit=1&cursor=${page1.nextCursor}`),
    );
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    const actions = (
      await json<AuditEventPage>(await admin.request('GET', '/audit?action=invitation.&limit=100'))
    ).items.map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['invitation.create', 'invitation.accept']));
    expect(actions.every((action) => action.startsWith('invitation.'))).toBe(true);

    const future = await json<AuditEventPage>(
      await admin.request('GET', '/audit?since=2999-01-01T00:00:00.000Z'),
    );
    expect(future.items).toEqual([]);
  });

  it('changes the password, ends other sessions and signs out', async () => {
    const other = new Client(app);
    await other.request('POST', '/auth/login', { email: adminEmail, password: PASSWORD });
    const sessionsList = await json<SessionList>(await admin.request('GET', '/me/sessions'));
    expect(sessionsList.items.filter((s) => s.current)).toHaveLength(1);

    const wrongCurrent = await admin.request('POST', '/me/password', {
      currentPassword: 'nope',
      newPassword: `${PASSWORD}!`,
    });
    expect(wrongCurrent.status).toBe(400);
    const changed = await admin.request('POST', '/me/password', {
      currentPassword: PASSWORD,
      newPassword: `${PASSWORD}!`,
    });
    expect(changed.status).toBe(204);
    expect((await other.request('GET', '/me')).status).toBe(401);
    expect((await admin.request('GET', '/me')).status).toBe(200);

    expect((await admin.request('POST', '/auth/logout')).status).toBe(204);
    expect(admin.cookie).toBeNull();
    const relogin = await admin.request('POST', '/auth/login', {
      email: adminEmail,
      password: `${PASSWORD}!`,
    });
    expect(relogin.status).toBe(200);
  });

  it('registers a passkey for a passwordless invitee and signs in with it', async () => {
    const created = await json<CreatedInvitation>(
      await admin.request('POST', '/invitations', { role: 'viewer' }),
    );
    const email = `passkey-${unique()}@example.com`;
    const invitee = new Client(app);
    const accepted = await invitee.request('POST', `/invitations/${created.token}/accept`, {
      name: 'Passkey User',
      email,
    });
    expect(accepted.status).toBe(201);
    const userId = (await json<Me>(accepted)).user.id;

    const authenticator = createSoftAuthenticator(ORIGIN);
    const regOptions = await json<Record<string, unknown>>(
      await invitee.request('POST', '/auth/passkeys/register/options'),
    );
    expect(regOptions).toMatchObject({
      rp: { id: 'localhost', name: 'Slipway' },
      user: { name: email },
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });

    // A response for another origin is rejected (and burns nothing it should not).
    const evil = createSoftAuthenticator(ORIGIN);
    const rejected = await invitee.request('POST', '/auth/passkeys/register/verify', {
      credential: evil.register(regOptions, { origin: 'https://evil.example' }),
    });
    expect(rejected.status).toBe(400);

    const freshOptions = await json<Record<string, unknown>>(
      await invitee.request('POST', '/auth/passkeys/register/options'),
    );
    const registered = await invitee.request('POST', '/auth/passkeys/register/verify', {
      name: 'Laptop',
      credential: authenticator.register(freshOptions),
    });
    expect(registered.status).toBe(201);
    const passkey = await json<{ id: string; name: string }>(registered);
    expect(passkey.name).toBe('Laptop');

    const list = await json<{ items: unknown[] }>(await invitee.request('GET', '/me/passkeys'));
    expect(list.items).toHaveLength(1);
    // The last credential of a passwordless account cannot be removed.
    expect((await invitee.request('DELETE', `/me/passkeys/${passkey.id}`)).status).toBe(409);
    const renamed = await invitee.request('PATCH', `/me/passkeys/${passkey.id}`, { name: 'Desk' });
    expect(await json(renamed)).toMatchObject({ name: 'Desk' });

    const browser = new Client(app);
    const loginOptions = await json<Record<string, unknown>>(
      await browser.request('POST', '/auth/passkeys/login/options'),
    );
    const assertion = authenticator.authenticate(loginOptions);
    const signedIn = await browser.request('POST', '/auth/passkeys/login/verify', {
      credential: assertion,
    });
    expect(signedIn.status).toBe(200);
    expect(await json(signedIn)).toMatchObject({ authMethod: 'session', user: { id: userId } });
    expect(browser.cookie).not.toBeNull();

    const replay = await new Client(app).request('POST', '/auth/passkeys/login/verify', {
      credential: assertion,
    });
    expect(replay.status).toBe(401);

    const [stored] = await db.select().from(passkeys).where(eq(passkeys.userId, userId));
    expect(stored).toMatchObject({ counter: 1, deviceType: 'singleDevice' });
    expect(stored?.lastUsedAt).not.toBeNull();
    const userSessions = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(userSessions).toHaveLength(2);
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.passwordHash).toBeNull();
  });
});
