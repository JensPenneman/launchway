import type {
  Passkey,
  PasskeyId,
  PasskeyList,
  PasskeyLoginInput,
  PasskeyRegistrationInput,
  UserId,
  WebAuthnOptions,
} from '@launchway/contracts';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { and, asc, count, eq } from 'drizzle-orm';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import { hashToken } from '../../lib/crypto.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/problem.js';
import { recordAudit } from '../audit/service.js';
import { users } from '../users/schema.js';
import { loadUser } from '../users/service.js';
import { CHALLENGE_TTL_MS, type ChallengeStore, createChallengeStore } from './challenges.js';
import { passkeys, sessions } from './schema.js';
import { actingAs, type SignedIn, sessionMe, startSession } from './service.js';

type PasskeyRow = typeof passkeys.$inferSelect;

/** WebAuthn relying party: the platform origin and its host name (rpID). */
export interface RelyingParty {
  readonly origin: string;
  readonly rpID: string;
}

export function relyingPartyFor(origin: string): RelyingParty {
  return { origin, rpID: new URL(origin).hostname };
}

const RP_NAME = 'Launchway';
const DEFAULT_PASSKEY_NAME = 'Passkey';

function toPasskey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    transports: row.transports,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** Options JSON for the browser; the library types are closed interfaces, the contract a record. */
function asOptions(options: object): WebAuthnOptions {
  return { ...options };
}

export interface PasskeyUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
}

export interface PasskeyService {
  registrationOptions(rp: RelyingParty, user: PasskeyUser): Promise<WebAuthnOptions>;
  register(
    rp: RelyingParty,
    user: PasskeyUser,
    input: PasskeyRegistrationInput,
    actor: RequestActor,
  ): Promise<Passkey>;
  loginOptions(rp: RelyingParty): Promise<WebAuthnOptions>;
  /** `previousToken`: the session cookie the request carried; that session is ended. */
  login(
    rp: RelyingParty,
    input: PasskeyLoginInput,
    actor: RequestActor,
    previousToken: string | null,
  ): Promise<SignedIn>;
  list(userId: UserId): Promise<PasskeyList>;
  rename(userId: UserId, id: PasskeyId, name: string, actor: RequestActor): Promise<Passkey>;
  remove(userId: UserId, id: PasskeyId, actor: RequestActor): Promise<void>;
}

export interface PasskeyServiceOptions {
  readonly challenges?: ChallengeStore;
}

export function createPasskeyService(
  deps: Pick<Deps, 'db' | 'events' | 'logger'>,
  options: PasskeyServiceOptions = {},
): PasskeyService {
  const challenges = options.challenges ?? createChallengeStore();

  function burnLoginChallenge(response: AuthenticationResponseJSON): void {
    try {
      challenges.consume(
        decodeClientDataJSON(response.response.clientDataJSON).challenge,
        'login',
        null,
      );
    } catch {
      // Malformed clientDataJSON: there is no challenge to burn.
    }
  }

  return {
    async registrationOptions(rp, user) {
      const existing = await deps.db
        .select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
        .from(passkeys)
        .where(eq(passkeys.userId, user.id));
      const result = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpID,
        userName: user.email,
        userDisplayName: user.name,
        userID: new TextEncoder().encode(user.id),
        attestationType: 'none',
        timeout: CHALLENGE_TTL_MS,
        excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      challenges.remember(result.challenge, 'register', user.id);
      return asOptions(result);
    },

    async register(rp, user, input, actor) {
      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: input.credential as unknown as RegistrationResponseJSON,
          expectedChallenge: (challenge) => challenges.consume(challenge, 'register', user.id),
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
          requireUserVerification: true,
        });
      } catch (err) {
        deps.logger.info({ err, userId: user.id }, 'passkey registration rejected');
        throw badRequest('The passkey could not be verified; request new options and try again');
      }
      if (!verification.verified) {
        throw badRequest('The passkey could not be verified; request new options and try again');
      }
      const info = verification.registrationInfo;

      let row: PasskeyRow;
      try {
        row = await deps.db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(passkeys)
            .values({
              userId: user.id,
              name: input.name ?? DEFAULT_PASSKEY_NAME,
              credentialId: info.credential.id,
              publicKey: Buffer.from(info.credential.publicKey),
              counter: info.credential.counter,
              transports: info.credential.transports ?? [],
              deviceType: info.credentialDeviceType,
              backedUp: info.credentialBackedUp,
              aaguid: info.aaguid,
            })
            .returning();
          if (!inserted) throw new Error('passkey insert returned no row');
          await recordAudit(tx, actor, {
            action: 'passkey.create',
            target: { type: 'passkey', id: inserted.id },
            summary: { name: inserted.name, deviceType: inserted.deviceType },
          });
          return inserted;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('This passkey is already registered');
        throw error;
      }
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: user.id });
      return toPasskey(row);
    },

    async loginOptions(rp) {
      const result = await generateAuthenticationOptions({
        rpID: rp.rpID,
        userVerification: 'required',
        timeout: CHALLENGE_TTL_MS,
      });
      challenges.remember(result.challenge, 'login', null);
      return asOptions(result);
    },

    async login(rp, input, actor, previousToken) {
      const response = input.credential as unknown as AuthenticationResponseJSON;
      const [found] = await deps.db
        .select({ passkey: passkeys, email: users.email })
        .from(passkeys)
        .innerJoin(users, eq(users.id, passkeys.userId))
        .where(eq(passkeys.credentialId, input.credential.id));
      const failed = () => unauthorized('Passkey sign-in failed');
      if (!found) {
        // Burn the challenge anyway so it cannot be replayed with another credential.
        burnLoginChallenge(response);
        deps.logger.info('passkey sign-in with an unknown credential');
        throw failed();
      }
      const stored = found.passkey;

      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: (challenge) => challenges.consume(challenge, 'login', null),
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
          credential: {
            id: stored.credentialId,
            publicKey: new Uint8Array(stored.publicKey),
            counter: stored.counter,
            transports: stored.transports,
          },
          requireUserVerification: true,
        });
      } catch (err) {
        deps.logger.info({ err, passkeyId: stored.id }, 'passkey sign-in rejected');
        throw failed();
      }
      if (!verification.verified) throw failed();
      const info = verification.authenticationInfo;
      const user = { id: stored.userId, email: found.email };

      const result = await deps.db.transaction(async (tx) => {
        if (previousToken) {
          await tx.delete(sessions).where(eq(sessions.tokenHash, hashToken(previousToken)));
        }
        await tx
          .update(passkeys)
          .set({
            counter: info.newCounter,
            backedUp: info.credentialBackedUp,
            deviceType: info.credentialDeviceType,
            lastUsedAt: new Date(),
          })
          .where(eq(passkeys.id, stored.id));
        const as = actingAs(actor, user);
        const session = await startSession(tx, user.id, as);
        await recordAudit(tx, as, {
          action: 'auth.login',
          target: { type: 'user', id: user.id },
          summary: { method: 'passkey', passkeyId: stored.id, sessionId: session.sessionId },
        });
        const loaded = await loadUser(tx, user.id);
        if (!loaded) throw failed();
        return { ...session, user: loaded };
      });
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: user.id });
      return { token: result.token, me: sessionMe(result.user, result.sessionId) };
    },

    async list(userId) {
      const rows = await deps.db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, userId))
        .orderBy(asc(passkeys.createdAt), asc(passkeys.id));
      return { items: rows.map(toPasskey) };
    },

    async rename(userId, id, name, actor) {
      const row = await deps.db.transaction(async (tx) => {
        const [before] = await tx
          .select({ name: passkeys.name })
          .from(passkeys)
          .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
          .for('update');
        if (!before) throw notFound('Passkey not found');
        const [after] = await tx
          .update(passkeys)
          .set({ name })
          .where(eq(passkeys.id, id))
          .returning();
        if (!after) throw notFound('Passkey not found');
        await recordAudit(tx, actor, {
          action: 'passkey.update',
          target: { type: 'passkey', id },
          summary: { name: { from: before.name, to: after.name } },
        });
        return after;
      });
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: userId });
      return toPasskey(row);
    },

    async remove(userId, id, actor) {
      await deps.db.transaction(async (tx) => {
        // Lock the user row so two concurrent deletions cannot remove the last two credentials.
        const [user] = await tx
          .select({ passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!user) throw notFound('Passkey not found');
        const [target] = await tx
          .select({ name: passkeys.name })
          .from(passkeys)
          .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)));
        if (!target) throw notFound('Passkey not found');
        const [total] = await tx
          .select({ n: count() })
          .from(passkeys)
          .where(eq(passkeys.userId, userId));
        if (user.passwordHash === null && (total?.n ?? 0) <= 1) {
          throw conflict('Set a password or add another passkey before removing your last passkey');
        }
        await tx.delete(passkeys).where(eq(passkeys.id, id));
        await recordAudit(tx, actor, {
          action: 'passkey.delete',
          target: { type: 'passkey', id },
          summary: { name: target.name },
        });
      });
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: userId });
    },
  };
}
