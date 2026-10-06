import { DisplayName, Email, IpAddress, JsonObject, Password, Timestamp } from './common.js';
import { ApiTokenId, PasskeyId, SessionId } from './ids.js';
import { list } from './pagination.js';
import { TokenScope } from './tokens.js';
import { User } from './users.js';
import { z } from './zod.js';

/** Session cookie (HttpOnly, SameSite=Lax, Secure over HTTPS), 30-day sliding expiry. */
export const SESSION_COOKIE_NAME = 'slipway_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// --- First run -------------------------------------------------------------------------------

export const SetupStatus = z
  .object({ setupRequired: z.boolean().openapi({ description: 'True while no owner exists' }) })
  .openapi('SetupStatus');
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupInput = z
  .strictObject({ email: Email, name: DisplayName, password: Password })
  .openapi('SetupInput');
export type SetupInput = z.infer<typeof SetupInput>;

// --- Password sign-in ------------------------------------------------------------------------

export const LoginInput = z
  .strictObject({ email: Email, password: z.string().min(1).max(256) })
  .openapi('LoginInput');
export type LoginInput = z.infer<typeof LoginInput>;

export const ChangePasswordInput = z
  .strictObject({
    currentPassword: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: 'Required when the user already has a password' }),
    newPassword: Password,
  })
  .openapi('ChangePasswordInput');
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

// --- Current principal -----------------------------------------------------------------------

export const AUTH_METHODS = ['session', 'token'] as const;
export const AuthMethod = z.enum(AUTH_METHODS);
export type AuthMethod = z.infer<typeof AuthMethod>;

export const Me = z
  .object({
    user: User,
    authMethod: AuthMethod,
    sessionId: SessionId.nullable(),
    tokenId: ApiTokenId.nullable(),
    scopes: z
      .array(TokenScope)
      .nullable()
      .openapi({ description: 'Token scopes; null for sessions' }),
  })
  .openapi('Me');
export type Me = z.infer<typeof Me>;

export const UpdateMeInput = z
  .strictObject({ name: DisplayName.optional(), email: Email.optional() })
  .refine((v) => v.name !== undefined || v.email !== undefined, 'Provide at least one field')
  .openapi('UpdateMeInput');
export type UpdateMeInput = z.infer<typeof UpdateMeInput>;

// --- Sessions --------------------------------------------------------------------------------

export const Session = z
  .object({
    id: SessionId,
    current: z.boolean(),
    ipAddress: IpAddress.nullable(),
    userAgent: z.string().nullable(),
    createdAt: Timestamp,
    lastUsedAt: Timestamp,
    expiresAt: Timestamp,
  })
  .openapi('Session');
export type Session = z.infer<typeof Session>;

export const SessionList = list(Session).openapi('SessionList');
export type SessionList = z.infer<typeof SessionList>;

// --- Passkeys (WebAuthn via @simplewebauthn) -------------------------------------------------

export const PASSKEY_DEVICE_TYPES = ['singleDevice', 'multiDevice'] as const;

export const Passkey = z
  .object({
    id: PasskeyId,
    name: DisplayName,
    deviceType: z.enum(PASSKEY_DEVICE_TYPES),
    backedUp: z.boolean(),
    transports: z.array(z.string()),
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
  })
  .openapi('Passkey');
export type Passkey = z.infer<typeof Passkey>;

export const PasskeyList = list(Passkey).openapi('PasskeyList');
export type PasskeyList = z.infer<typeof PasskeyList>;

/** `PublicKeyCredentialCreationOptionsJSON` / `...RequestOptionsJSON`, passed to the browser as is. */
export const WebAuthnOptions = JsonObject.openapi('WebAuthnOptions', {
  description: 'WebAuthn options JSON produced by @simplewebauthn/server',
});
export type WebAuthnOptions = z.infer<typeof WebAuthnOptions>;

/** `RegistrationResponseJSON` / `AuthenticationResponseJSON` from the browser. */
export const WebAuthnCredential = z
  .looseObject({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: JsonObject,
  })
  .openapi('WebAuthnCredential');
export type WebAuthnCredential = z.infer<typeof WebAuthnCredential>;

export const PasskeyRegistrationInput = z
  .strictObject({ name: DisplayName.optional(), credential: WebAuthnCredential })
  .openapi('PasskeyRegistrationInput');
export type PasskeyRegistrationInput = z.infer<typeof PasskeyRegistrationInput>;

export const PasskeyLoginInput = z
  .strictObject({ credential: WebAuthnCredential })
  .openapi('PasskeyLoginInput');
export type PasskeyLoginInput = z.infer<typeof PasskeyLoginInput>;

export const RenamePasskeyInput = z
  .strictObject({ name: DisplayName })
  .openapi('RenamePasskeyInput');
export type RenamePasskeyInput = z.infer<typeof RenamePasskeyInput>;
