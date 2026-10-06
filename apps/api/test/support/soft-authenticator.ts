import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

function counterBytes(counter: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(counter);
  return buffer;
}

/**
 * A minimal software WebAuthn authenticator (ES256, `none` attestation) for tests: produces the
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON` a browser would send, signed with a
 * real P-256 key, so the server-side verification runs unmodified.
 */
export function createSoftAuthenticator(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  let counter = 0;

  const cosePublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x ?? '', 'base64url')],
      [-3, Buffer.from(jwk.y ?? '', 'base64url')],
    ]),
  );

  function clientData(type: string, challenge: string, actualOrigin: string): string {
    return JSON.stringify({ type, challenge, origin: actualOrigin, crossOrigin: false });
  }

  return {
    credentialId: b64url(credentialId),

    /** Answer to `navigator.credentials.create()` for the given creation options. */
    register(options: Record<string, unknown>, overrides: { origin?: string } = {}) {
      const challenge = String(options.challenge);
      const rpId = String((options.rp as { id: string }).id);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_DATA]),
        counterBytes(counter),
        Buffer.alloc(16), // AAGUID
        idLength,
        credentialId,
        Buffer.from(cosePublicKey),
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ]) as Parameters<typeof isoCBOR.encode>[0],
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(
            clientData('webauthn.create', challenge, overrides.origin ?? origin),
          ),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },

    /** Answer to `navigator.credentials.get()` for the given request options. */
    authenticate(options: Record<string, unknown>) {
      counter += 1;
      const challenge = String(options.challenge);
      const rpId = String(options.rpId);
      const authenticatorData = Buffer.concat([
        sha256(rpId),
        Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED]),
        counterBytes(counter),
      ]);
      const clientDataJSON = clientData('webauthn.get', challenge, origin);
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}
