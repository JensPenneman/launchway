import type { WebAuthnCredential } from '@launchway/contracts';
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
} from '@/api/auth';

/** The user dismissed the browser's passkey prompt; not worth an error toast. */
export function isPasskeyCancelled(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}

/** Discoverable-credential sign-in: no e-mail needed, the authenticator picks the account. */
export async function signInWithPasskey(): Promise<void> {
  const options = await passkeyLoginOptions();
  const credential = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  await verifyPasskeyLogin(credential);
}

/** Registers a new passkey for the signed-in user. */
export async function registerPasskey(name?: string): Promise<void> {
  const options = await passkeyRegistrationOptions();
  const credential = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  await verifyPasskeyRegistration({
    ...(name ? { name } : {}),
    credential: credential as unknown as WebAuthnCredential,
  });
}
