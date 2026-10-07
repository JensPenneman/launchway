import { createRoute, z } from '@hono/zod-openapi';
import {
  ChangePasswordInput,
  LoginInput,
  Me,
  Passkey,
  PasskeyId,
  PasskeyList,
  PasskeyLoginInput,
  PasskeyRegistrationInput,
  RenamePasskeyInput,
  SessionId,
  SessionList,
  SetupInput,
  SetupStatus,
  UpdateMeInput,
  WebAuthnOptions,
} from '@slipway/contracts';
import type { Context } from 'hono';
import type { Api, AppEnv, Deps } from '../../deps.js';
import {
  getPrincipal,
  getSessionPrincipal,
  requestActor,
  requireRole,
} from '../../lib/auth-context.js';
import { createPlatformOriginResolver } from '../../lib/csrf.js';
import {
  AUTHENTICATED,
  jsonBody,
  jsonResponse,
  PUBLIC,
  problemResponses,
} from '../../lib/openapi.js';
import { createRateLimiter, enforceRateLimit } from '../../lib/rate-limit.js';
import { createPasskeyService, relyingPartyFor } from './passkeys.js';
import { createAuthService } from './service.js';
import { clearSessionCookie, readSessionCookie, writeSessionCookie } from './session-cookie.js';

/** Password attempts per account (any client): 10 in a burst, then one every 30 s. */
const LOGIN_ACCOUNT_LIMIT = { capacity: 10, refillPerSecond: 1 / 30 };
const SessionParams = z.object({ id: SessionId });
const PasskeyParams = z.object({ id: PasskeyId });
const signedIn = 'Signed in; the response sets the `slipway_session` cookie';

// --- First run ---------------------------------------------------------------------------------

const getSetup = createRoute({
  method: 'get',
  path: '/setup',
  operationId: 'getSetupStatus',
  tags: ['Auth'],
  summary: 'Whether the first-run setup is still required',
  security: PUBLIC,
  responses: { 200: jsonResponse(SetupStatus, 'Setup status') },
});

const postSetup = createRoute({
  method: 'post',
  path: '/setup',
  operationId: 'completeSetup',
  tags: ['Auth'],
  summary: 'Create the owner account (first run only)',
  description:
    'Only allowed while no user exists. Creates the owner and signs them in. Rate limited.',
  security: PUBLIC,
  request: { body: jsonBody(SetupInput) },
  responses: {
    201: jsonResponse(Me, signedIn),
    ...problemResponses(400, 403, 409, 429),
  },
});

// --- Password sign-in --------------------------------------------------------------------------

const login = createRoute({
  method: 'post',
  path: '/auth/login',
  operationId: 'login',
  tags: ['Auth'],
  summary: 'Sign in with e-mail and password',
  description: 'Starts a new session (any session the request carried is ended). Rate limited.',
  security: PUBLIC,
  request: { body: jsonBody(LoginInput) },
  responses: {
    200: jsonResponse(Me, signedIn),
    ...problemResponses(400, 401, 403, 429),
  },
});

const logout = createRoute({
  method: 'post',
  path: '/auth/logout',
  operationId: 'logout',
  tags: ['Auth'],
  summary: 'Sign out (ends the current session)',
  description: 'Idempotent: also succeeds without a session. Clears the session cookie.',
  security: PUBLIC,
  responses: { 204: { description: 'Signed out' }, ...problemResponses(401, 403) },
});

// --- Current user ------------------------------------------------------------------------------

const getMe = createRoute({
  method: 'get',
  path: '/me',
  operationId: 'getMe',
  tags: ['Auth'],
  summary: 'The signed-in user and how they authenticated',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: { 200: jsonResponse(Me, 'The caller'), ...problemResponses(401, 403) },
});

const updateMe = createRoute({
  method: 'patch',
  path: '/me',
  operationId: 'updateMe',
  tags: ['Auth'],
  summary: 'Change your name or e-mail address',
  description: 'Requires a signed-in session (not an API token). Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { body: jsonBody(UpdateMeInput) },
  responses: {
    200: jsonResponse(Me, 'The updated caller'),
    ...problemResponses(400, 401, 403, 409),
  },
});

const changePassword = createRoute({
  method: 'post',
  path: '/me/password',
  operationId: 'changePassword',
  tags: ['Auth'],
  summary: 'Set or change your password',
  description:
    '`currentPassword` is required when a password is set. Ends all other sessions and revokes ' +
    'all of your API tokens. Requires a signed-in session. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { body: jsonBody(ChangePasswordInput) },
  responses: { 204: { description: 'Password changed' }, ...problemResponses(400, 401, 403) },
});

const listSessions = createRoute({
  method: 'get',
  path: '/me/sessions',
  operationId: 'listSessions',
  tags: ['Auth'],
  summary: 'Your active sessions',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(SessionList, 'Active sessions, most recently used first'),
    ...problemResponses(401, 403),
  },
});

const revokeSession = createRoute({
  method: 'delete',
  path: '/me/sessions/{id}',
  operationId: 'revokeSession',
  tags: ['Auth'],
  summary: 'End one of your sessions',
  description: 'Requires a signed-in session. Ending the current session also clears the cookie.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: SessionParams },
  responses: { 204: { description: 'Session ended' }, ...problemResponses(400, 401, 403, 404) },
});

// --- Passkeys ----------------------------------------------------------------------------------

const passkeyRegisterOptions = createRoute({
  method: 'post',
  path: '/auth/passkeys/register/options',
  operationId: 'passkeyRegistrationOptions',
  tags: ['Auth'],
  summary: 'Start registering a passkey',
  description:
    'Returns `PublicKeyCredentialCreationOptionsJSON` for `navigator.credentials.create()` ' +
    '(discoverable credential, user verification required). Valid for 5 minutes. Requires a ' +
    'signed-in session. Rate limited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(WebAuthnOptions, 'Registration options'),
    ...problemResponses(401, 403, 429),
  },
});

const passkeyRegisterVerify = createRoute({
  method: 'post',
  path: '/auth/passkeys/register/verify',
  operationId: 'registerPasskey',
  tags: ['Auth'],
  summary: 'Finish registering a passkey',
  description: 'Verifies the attestation and stores the credential. Rate limited. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { body: jsonBody(PasskeyRegistrationInput) },
  responses: {
    201: jsonResponse(Passkey, 'The registered passkey'),
    ...problemResponses(400, 401, 403, 409, 429),
  },
});

const passkeyLoginOptions = createRoute({
  method: 'post',
  path: '/auth/passkeys/login/options',
  operationId: 'passkeyLoginOptions',
  tags: ['Auth'],
  summary: 'Start signing in with a passkey',
  description:
    'Returns `PublicKeyCredentialRequestOptionsJSON` without `allowCredentials` (discoverable ' +
    'credentials: no e-mail needed). Valid for 5 minutes. Rate limited.',
  security: PUBLIC,
  responses: {
    200: jsonResponse(WebAuthnOptions, 'Authentication options'),
    ...problemResponses(403, 429),
  },
});

const passkeyLoginVerify = createRoute({
  method: 'post',
  path: '/auth/passkeys/login/verify',
  operationId: 'loginWithPasskey',
  tags: ['Auth'],
  summary: 'Finish signing in with a passkey',
  description: 'Verifies the assertion and starts a new session. Rate limited.',
  security: PUBLIC,
  request: { body: jsonBody(PasskeyLoginInput) },
  responses: {
    200: jsonResponse(Me, signedIn),
    ...problemResponses(400, 401, 403, 429),
  },
});

const listPasskeys = createRoute({
  method: 'get',
  path: '/me/passkeys',
  operationId: 'listPasskeys',
  tags: ['Auth'],
  summary: 'Your passkeys',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: { 200: jsonResponse(PasskeyList, 'Your passkeys'), ...problemResponses(401, 403) },
});

const renamePasskey = createRoute({
  method: 'patch',
  path: '/me/passkeys/{id}',
  operationId: 'renamePasskey',
  tags: ['Auth'],
  summary: 'Rename one of your passkeys',
  description: 'Requires a signed-in session. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: PasskeyParams, body: jsonBody(RenamePasskeyInput) },
  responses: {
    200: jsonResponse(Passkey, 'The renamed passkey'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const deletePasskey = createRoute({
  method: 'delete',
  path: '/me/passkeys/{id}',
  operationId: 'deletePasskey',
  tags: ['Auth'],
  summary: 'Remove one of your passkeys',
  description:
    'Refused (409) for the last passkey of an account without a password. Requires a signed-in ' +
    'session. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: PasskeyParams },
  responses: {
    204: { description: 'Removed' },
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

export function registerAuthRoutes(api: Api, deps: Deps): void {
  const auth = createAuthService(deps);
  const accountLimiter = createRateLimiter();
  const passkeys = createPasskeyService(deps);
  const origins = createPlatformOriginResolver(deps);
  const relyingParty = async (c: Context<AppEnv>) => relyingPartyFor(await origins.forRequest(c));

  api.openapi(getSetup, async (c) => c.json(await auth.setupStatus(), 200));

  api.openapi(postSetup, async (c) => {
    const { token, me } = await auth.setup(c.req.valid('json'), requestActor(c));
    writeSessionCookie(c, token);
    return c.json(me, 201);
  });

  api.openapi(login, async (c) => {
    const input = c.req.valid('json');
    // Per account as well as per client: guessing one account's password from many addresses.
    enforceRateLimit(
      accountLimiter,
      `login-account:${input.email.toLowerCase()}`,
      LOGIN_ACCOUNT_LIMIT,
      c.get('logger'),
    );
    const { token, me } = await auth.login(input, requestActor(c), readSessionCookie(c));
    writeSessionCookie(c, token);
    return c.json(me, 200);
  });

  api.openapi(logout, async (c) => {
    const principal = c.get('principal');
    if (principal?.kind === 'session') await auth.logout(principal, requestActor(c));
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  api.openapi(getMe, async (c) => c.json(await auth.me(getPrincipal(c)), 200));

  api.openapi(updateMe, async (c) =>
    c.json(await auth.updateMe(getSessionPrincipal(c), c.req.valid('json'), requestActor(c)), 200),
  );

  api.openapi(changePassword, async (c) => {
    await auth.changePassword(getSessionPrincipal(c), c.req.valid('json'), requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(listSessions, async (c) => c.json(await auth.listSessions(getPrincipal(c)), 200));

  api.openapi(revokeSession, async (c) => {
    const principal = getSessionPrincipal(c);
    const { id } = c.req.valid('param');
    await auth.revokeSession(principal, id, requestActor(c));
    if (id === principal.sessionId) clearSessionCookie(c);
    return c.body(null, 204);
  });

  api.openapi(passkeyRegisterOptions, async (c) => {
    const { user } = getSessionPrincipal(c);
    return c.json(await passkeys.registrationOptions(await relyingParty(c), user), 200);
  });

  api.openapi(passkeyRegisterVerify, async (c) => {
    const { user } = getSessionPrincipal(c);
    const passkey = await passkeys.register(
      await relyingParty(c),
      user,
      c.req.valid('json'),
      requestActor(c),
    );
    return c.json(passkey, 201);
  });

  api.openapi(passkeyLoginOptions, async (c) =>
    c.json(await passkeys.loginOptions(await relyingParty(c)), 200),
  );

  api.openapi(passkeyLoginVerify, async (c) => {
    const { token, me } = await passkeys.login(
      await relyingParty(c),
      c.req.valid('json'),
      requestActor(c),
      readSessionCookie(c),
    );
    writeSessionCookie(c, token);
    return c.json(me, 200);
  });

  api.openapi(listPasskeys, async (c) => c.json(await passkeys.list(getPrincipal(c).user.id), 200));

  api.openapi(renamePasskey, async (c) => {
    const { user } = getSessionPrincipal(c);
    const passkey = await passkeys.rename(
      user.id,
      c.req.valid('param').id,
      c.req.valid('json').name,
      requestActor(c),
    );
    return c.json(passkey, 200);
  });

  api.openapi(deletePasskey, async (c) => {
    const { user } = getSessionPrincipal(c);
    await passkeys.remove(user.id, c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });
}
