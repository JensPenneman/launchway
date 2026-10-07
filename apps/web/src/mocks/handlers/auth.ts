import {
  AcceptInvitationInput,
  ChangePasswordInput,
  CreateApiTokenInput,
  type CreatedInvitation,
  CreateInvitationInput,
  generateId,
  type Invitation,
  LoginInput,
  type Me,
  PasskeyRegistrationInput,
  RenamePasskeyInput,
  SetupInput,
  UpdateMeInput,
  UpdateUserInput,
  type User,
} from '@launchway/contracts';
import { HttpResponse, http } from 'msw';
import { db } from '../db';
import { MOCK_INVITATION_TOKEN } from '../fixtures';
import {
  API,
  guard,
  json,
  now,
  paginate,
  parseBody,
  problem,
  randomToken,
  recordAudit,
} from '../util';

/** Password every mock user signs in with. */
export const MOCK_PASSWORD = 'correct horse battery staple';

function me(user: User): Me {
  return {
    user,
    authMethod: 'session',
    sessionId: db.sessions[0]?.id ?? null,
    tokenId: null,
    scopes: null,
  };
}

function signIn(user: User) {
  db.sessionUserId = user.id;
  user.lastLoginAt = now();
  return json(me(user));
}

const invitationTokens = new Map<string, string>(); // token -> invitation id

function challenge(): string {
  return randomToken('').slice(0, 32);
}

export const authHandlers = [
  http.get('/api/health/live', () => HttpResponse.json({ status: 'ok', version: 'mock' })),
  http.get('/api/health/ready', () => HttpResponse.json({ status: 'ok', version: 'mock' })),

  // --- Setup -------------------------------------------------------------------------------------
  http.get(`${API}/setup`, () =>
    HttpResponse.json({ setupRequired: db.users.length === 0, setupTokenRequired: false }),
  ),
  http.post(`${API}/setup`, async ({ request }) => {
    if (db.users.length > 0) return problem('conflict', 'Launchway is already set up.');
    const { data, error } = await parseBody(request, SetupInput);
    if (error) return error;
    const user: User = {
      id: generateId('user'),
      email: data.email,
      name: data.name,
      role: 'owner',
      hasPassword: true,
      passkeyCount: 0,
      lastLoginAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    db.users.push(user);
    recordAudit('setup.complete', 'user', user.id);
    return signIn(user);
  }),

  // --- Sessions ----------------------------------------------------------------------------------
  http.post(`${API}/auth/login`, async ({ request }) => {
    const { data, error } = await parseBody(request, LoginInput);
    if (error) return error;
    const user = db.users.find((candidate) => candidate.email === data.email);
    if (!user || data.password !== MOCK_PASSWORD) {
      return problem('unauthorized', 'The e-mail or password is incorrect.');
    }
    return signIn(user);
  }),
  http.post(`${API}/auth/logout`, () => {
    db.sessionUserId = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/me`, () => {
    const user = db.currentUser();
    return user ? json(me(user)) : problem('unauthorized');
  }),
  http.patch(`${API}/me`, async ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const { data, error } = await parseBody(request, UpdateMeInput);
    if (error) return error;
    const user = db.currentUser();
    if (!user) return problem('unauthorized');
    Object.assign(user, data, { updatedAt: now() });
    recordAudit('user.update', 'user', user.id, { fields: Object.keys(data) });
    db.emit('users', 'updated', user.id);
    return HttpResponse.json(me(user));
  }),
  http.post(`${API}/me/password`, async ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const { data, error } = await parseBody(request, ChangePasswordInput);
    if (error) return error;
    const user = db.currentUser();
    if (user?.hasPassword && data.currentPassword !== MOCK_PASSWORD) {
      return problem('validation-failed', undefined, [
        {
          path: 'body.currentPassword',
          message: 'The current password is incorrect',
          code: 'custom',
        },
      ]);
    }
    if (user) user.hasPassword = true;
    recordAudit('user.password', 'user', user?.id ?? null);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(
    `${API}/me/sessions`,
    () => guard('viewer') ?? HttpResponse.json({ items: db.sessions }),
  ),
  http.delete(`${API}/me/sessions/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    db.sessions = db.sessions.filter((session) => session.id !== params.id || session.current);
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Passkeys ----------------------------------------------------------------------------------
  http.post(`${API}/auth/passkeys/login/options`, () =>
    HttpResponse.json({
      challenge: challenge(),
      rpId: location.hostname,
      allowCredentials: [],
      userVerification: 'preferred',
      timeout: 60_000,
    }),
  ),
  http.post(`${API}/auth/passkeys/login/verify`, () => {
    const owner = db.users.find((user) => user.role === 'owner');
    return owner ? signIn(owner) : problem('unauthorized', 'Unknown passkey.');
  }),
  http.post(`${API}/auth/passkeys/register/options`, () => {
    const user = db.currentUser();
    if (!user) return problem('unauthorized');
    return HttpResponse.json({
      challenge: challenge(),
      rp: { name: 'Launchway', id: location.hostname },
      user: { id: btoa(user.id).replace(/=+$/, ''), name: user.email, displayName: user.name },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      timeout: 60_000,
      attestation: 'none',
    });
  }),
  http.post(`${API}/auth/passkeys/register/verify`, async ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const { data, error } = await parseBody(request, PasskeyRegistrationInput);
    if (error) return error;
    const passkey = {
      id: generateId('pk'),
      name: data.name ?? `Passkey ${db.passkeys.length + 1}`,
      deviceType: 'multiDevice' as const,
      backedUp: true,
      transports: ['internal'],
      createdAt: now(),
      lastUsedAt: null,
    };
    db.passkeys.push(passkey);
    return HttpResponse.json(passkey, { status: 201 });
  }),
  http.get(
    `${API}/me/passkeys`,
    () => guard('viewer') ?? HttpResponse.json({ items: db.passkeys }),
  ),
  http.patch(`${API}/me/passkeys/:id`, async ({ request, params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const { data, error } = await parseBody(request, RenamePasskeyInput);
    if (error) return error;
    const passkey = db.passkeys.find((item) => item.id === params.id);
    if (!passkey) return problem('not-found');
    passkey.name = data.name;
    return HttpResponse.json(passkey);
  }),
  http.delete(`${API}/me/passkeys/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    db.passkeys = db.passkeys.filter((item) => item.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Users and invitations ---------------------------------------------------------------------
  http.get(
    `${API}/users`,
    ({ request }) => guard('admin') ?? HttpResponse.json(paginate(db.users, new URL(request.url))),
  ),
  http.patch(`${API}/users/:id`, async ({ request, params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, UpdateUserInput);
    if (error) return error;
    const user = db.users.find((item) => item.id === params.id);
    if (!user) return problem('not-found');
    if (user.role === 'owner') return problem('forbidden', 'The owner cannot be changed.');
    Object.assign(user, data, { updatedAt: now() });
    recordAudit('user.update', 'user', user.id, data);
    db.emit('users', 'updated', user.id);
    return HttpResponse.json(user);
  }),
  http.delete(`${API}/users/:id`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const user = db.users.find((item) => item.id === params.id);
    if (!user) return problem('not-found');
    if (user.role === 'owner') return problem('forbidden', 'The owner cannot be removed.');
    db.users = db.users.filter((item) => item !== user);
    recordAudit('user.delete', 'user', user.id);
    db.emit('users', 'deleted', user.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(
    `${API}/invitations`,
    ({ request }) =>
      guard('admin') ?? HttpResponse.json(paginate(db.invitations, new URL(request.url))),
  ),
  http.post(`${API}/invitations`, async ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateInvitationInput);
    if (error) return error;
    const inviter = db.currentUser();
    const invitation: Invitation = {
      id: generateId('inv'),
      email: data.email ?? null,
      role: data.role,
      status: 'pending',
      invitedBy: inviter ? { id: inviter.id, name: inviter.name, email: inviter.email } : null,
      expiresAt: new Date(Date.now() + data.expiresInHours * 3_600_000).toISOString(),
      acceptedAt: null,
      createdAt: now(),
    };
    db.invitations.unshift(invitation);
    const token = randomToken('lwyi_');
    invitationTokens.set(token, invitation.id);
    recordAudit('invitation.create', 'invitation', invitation.id, { role: data.role });
    db.emit('invitations', 'created', invitation.id);
    const created: CreatedInvitation = {
      invitation,
      token,
      url: `${location.origin}/invite#${token}`,
    };
    return HttpResponse.json(created, { status: 201 });
  }),
  http.delete(`${API}/invitations/:id`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    db.invitations = db.invitations.filter((item) => item.id !== params.id);
    db.emit('invitations', 'deleted', String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/invitations/:token`, ({ params }) => {
    const token = String(params.token);
    if (token === MOCK_INVITATION_TOKEN) {
      return HttpResponse.json({
        email: null,
        role: 'member',
        expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      });
    }
    const invitation = db.invitations.find((item) => item.id === invitationTokens.get(token));
    if (invitation?.status !== 'pending')
      return problem('gone', 'This invitation is no longer valid.');
    return HttpResponse.json({
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    });
  }),
  http.post(`${API}/invitations/:token/accept`, async ({ request, params }) => {
    const { data, error } = await parseBody(request, AcceptInvitationInput.omit({ token: true }));
    if (error) return error;
    const token = String(params.token);
    const invitation = db.invitations.find((item) => item.id === invitationTokens.get(token));
    if (token !== MOCK_INVITATION_TOKEN && !invitation) return problem('gone');
    const email = invitation?.email ?? data.email;
    if (!email) {
      return problem('validation-failed', undefined, [
        { path: 'body.email', message: 'Required', code: 'custom' },
      ]);
    }
    const user: User = {
      id: generateId('user'),
      email,
      name: data.name,
      role: invitation?.role ?? 'member',
      hasPassword: data.password !== undefined,
      passkeyCount: 0,
      lastLoginAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    db.users.push(user);
    if (invitation) Object.assign(invitation, { status: 'accepted', acceptedAt: now() });
    db.emit('users', 'created', user.id);
    return signIn(user);
  }),

  // --- API tokens --------------------------------------------------------------------------------
  http.get(`${API}/tokens`, () => guard('member') ?? HttpResponse.json({ items: db.tokens })),
  http.post(`${API}/tokens`, async ({ request }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateApiTokenInput);
    if (error) return error;
    const secret = randomToken('lwy_');
    const token = {
      id: generateId('tok'),
      name: data.name,
      scopes: data.scopes,
      tokenHint: secret.slice(0, 8),
      expiresAt: data.expiresAt,
      lastUsedAt: null,
      createdAt: now(),
    };
    db.tokens.unshift(token);
    recordAudit('token.create', 'token', token.id, { scopes: data.scopes });
    db.emit('tokens', 'created', token.id);
    return HttpResponse.json({ token, secret }, { status: 201 });
  }),
  http.delete(`${API}/tokens/:id`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    db.tokens = db.tokens.filter((item) => item.id !== params.id);
    recordAudit('token.delete', 'token', String(params.id));
    db.emit('tokens', 'deleted', String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Audit -------------------------------------------------------------------------------------
  http.get(`${API}/audit`, ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const actorId = url.searchParams.get('actorId');
    const targetType = url.searchParams.get('targetType');
    const targetId = url.searchParams.get('targetId');
    const items = db.audit.filter(
      (event) =>
        (!action || event.action.includes(action)) &&
        (!actorId || event.actor.id === actorId) &&
        (!targetType || event.target?.type === targetType) &&
        (!targetId || event.target?.id === targetId),
    );
    return HttpResponse.json(paginate(items, url));
  }),
];
