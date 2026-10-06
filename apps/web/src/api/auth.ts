import {
  type ChangePasswordInput,
  type LoginInput,
  Me,
  PasskeyList,
  type PasskeyRegistrationInput,
  type RenamePasskeyInput,
  SessionList,
  type SetupInput,
  SetupStatus,
  type UpdateMeInput,
  WebAuthnOptions,
} from '@slipway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

// --- First run ---------------------------------------------------------------------------------

export const setupStatusQuery = queryOptions({
  queryKey: keys.setup,
  queryFn: ({ signal }) =>
    request('/setup', { schema: SetupStatus, signal, onUnauthorized: 'throw' }),
  staleTime: 60_000,
});

export function createOwner(input: SetupInput) {
  return request('/setup', { method: 'POST', body: input, onUnauthorized: 'throw' });
}

// --- Session -----------------------------------------------------------------------------------

/** The signed-in principal; rejects with a 401 `ApiError` when nobody is signed in. */
export const meQuery = queryOptions({
  queryKey: keys.me,
  queryFn: ({ signal }) => request('/me', { schema: Me, signal, onUnauthorized: 'throw' }),
  staleTime: 5 * 60_000,
  retry: false,
});

export function login(input: LoginInput) {
  return request('/auth/login', { method: 'POST', body: input, onUnauthorized: 'throw' });
}

export function logout() {
  return request('/auth/logout', { method: 'POST', onUnauthorized: 'throw' });
}

export function updateMe(input: UpdateMeInput) {
  return request('/me', { method: 'PATCH', body: input });
}

export function changePassword(input: ChangePasswordInput) {
  return request('/me/password', { method: 'POST', body: input });
}

export const sessionsQuery = queryOptions({
  queryKey: keys.sessions,
  queryFn: ({ signal }) => request('/me/sessions', { schema: SessionList, signal }),
});

export function revokeSession(id: string) {
  return request(`/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Passkeys ----------------------------------------------------------------------------------

export const passkeysQuery = queryOptions({
  queryKey: keys.passkeys,
  queryFn: ({ signal }) => request('/me/passkeys', { schema: PasskeyList, signal }),
});

export function passkeyRegistrationOptions() {
  return request('/auth/passkeys/register/options', { method: 'POST', schema: WebAuthnOptions });
}

export function verifyPasskeyRegistration(input: PasskeyRegistrationInput) {
  return request('/auth/passkeys/register/verify', { method: 'POST', body: input });
}

export function passkeyLoginOptions() {
  return request('/auth/passkeys/login/options', {
    method: 'POST',
    schema: WebAuthnOptions,
    onUnauthorized: 'throw',
  });
}

export function verifyPasskeyLogin(credential: unknown) {
  return request('/auth/passkeys/login/verify', {
    method: 'POST',
    body: { credential },
    onUnauthorized: 'throw',
  });
}

export function renamePasskey(id: string, input: RenamePasskeyInput) {
  return request(`/me/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
}

export function deletePasskey(id: string) {
  return request(`/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
