import argon2 from 'argon2';
import { createWorkQueue } from '../../lib/work-queue.js';

/** argon2id with the library defaults (64 MiB, t=3, p=4). */
const OPTIONS = { type: argon2.argon2id } as const;

/** Two hashes at a time (128 MiB, half of libuv's pool); a flood of sign-ins gets 503s. */
const argonQueue = createWorkQueue(2, 32);

export function hashPassword(password: string): Promise<string> {
  return argonQueue(() => argon2.hash(password, OPTIONS));
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password against a stored hash. Without a hash (unknown user, passkey-only account)
 * a dummy hash is verified instead, so the response time does not reveal whether the account
 * exists. Always resolves false in that case.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword('launchway-dummy-password-for-timing');
    dummyHash.catch(() => {
      dummyHash = undefined;
    });
    const dummy = await dummyHash;
    await argonQueue(() => argon2.verify(dummy, password).catch(() => false));
    return false;
  }
  return argonQueue(() => argon2.verify(hash, password).catch(() => false));
}
