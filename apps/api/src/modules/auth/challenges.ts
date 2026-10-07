import type { UserId } from '@launchway/contracts';

/** How long a WebAuthn challenge stays valid. */
export const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 10_000;

export type ChallengePurpose = 'register' | 'login';

interface Entry {
  readonly purpose: ChallengePurpose;
  readonly userId: UserId | null;
  readonly expiresAt: number;
}

/**
 * Single-use WebAuthn challenges, in memory with a 5-minute TTL. Sign-in uses discoverable
 * credentials, so the challenge itself (echoed in clientDataJSON) is the lookup key; no cookie is
 * needed between `options` and `verify`. Only valid for a single API instance.
 */
export interface ChallengeStore {
  remember(challenge: string, purpose: ChallengePurpose, userId: UserId | null): void;
  /** True once for a live challenge of that purpose (and user); the challenge is then gone. */
  consume(challenge: string, purpose: ChallengePurpose, userId: UserId | null): boolean;
}

export function createChallengeStore(clock: () => number = Date.now): ChallengeStore {
  const entries = new Map<string, Entry>();

  function prune(now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    // Map iteration is insertion order: drop the oldest when still full.
    for (const key of entries.keys()) {
      if (entries.size < MAX_CHALLENGES) break;
      entries.delete(key);
    }
  }

  return {
    remember(challenge, purpose, userId) {
      const now = clock();
      if (entries.size >= MAX_CHALLENGES) prune(now);
      entries.set(challenge, { purpose, userId, expiresAt: now + CHALLENGE_TTL_MS });
    },
    consume(challenge, purpose, userId) {
      const entry = entries.get(challenge);
      if (!entry) return false;
      entries.delete(challenge);
      return entry.purpose === purpose && entry.userId === userId && entry.expiresAt > clock();
    },
  };
}
