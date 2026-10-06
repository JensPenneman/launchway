import argon2 from 'argon2';

/** argon2id with the library defaults (64 MiB, t=3, p=4). */
const OPTIONS = { type: argon2.argon2id } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password against a stored hash. Without a hash (unknown user, passkey-only account)
 * a dummy hash is verified instead, so the response time does not reveal whether the account
 * exists. Always resolves false in that case.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword('slipway-dummy-password-for-timing');
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
