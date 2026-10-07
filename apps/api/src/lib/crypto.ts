import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Purpose-bound subkeys derived from LAUNCHWAY_SECRET_KEY (HKDF-SHA256). */
export type KeyPurpose = 'secrets' | 'cookies';

export function deriveKey(masterKey: Buffer, purpose: KeyPurpose): Buffer {
  if (masterKey.length !== 32) throw new RangeError('The master key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `launchway:${purpose}:v1`, 32));
}

export class DecryptionError extends Error {
  constructor() {
    super('Unable to decrypt value (wrong key, wrong context or tampered data)');
    this.name = 'DecryptionError';
  }
}

/**
 * Authenticated encryption for secrets at rest (spec section 14): AES-256-GCM with a random
 * 96-bit IV per value. Output: `v1.<iv>.<ciphertext>.<tag>` (base64url), stored in text columns
 * named `...Encrypted`. Pass `context` (AAD) to bind a ciphertext to its record, e.g.
 * `env:<appId>:<key>`; decryption fails if the value is moved to another record.
 */
export interface SecretBox {
  encrypt(plaintext: string, context?: string): string;
  decrypt(ciphertext: string, context?: string): string;
}

export function createSecretBox(masterKey: Buffer): SecretBox {
  const key = deriveKey(masterKey, 'secrets');
  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      if (context !== undefined) cipher.setAAD(Buffer.from(context, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [FORMAT_VERSION, iv, encrypted, cipher.getAuthTag()]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.');
    },
    decrypt(value, context) {
      const [version, iv, encrypted, tag, ...rest] = value.split('.');
      if (version !== FORMAT_VERSION || !iv || encrypted === undefined || !tag || rest.length > 0) {
        throw new DecryptionError();
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
          authTagLength: TAG_BYTES,
        });
        if (context !== undefined) decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(encrypted, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new DecryptionError();
      }
    },
  };
}

/** SHA-256 (hex) of a token; tokens, session ids and node credentials are stored only as hashes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string comparison (hashes first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  );
}

function base62(bytes: Buffer, length: number): string {
  let value = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) {
    out = BASE62.charAt(Number(value % 62n)) + out;
    value /= 62n;
  }
  return out.padStart(length, '0');
}

/**
 * Random token `<prefix><base62>` from `bytes` random bytes; 32 bytes give 43 characters, e.g.
 * `lwy_…` (API token), `lwyn_…` (join token), `lwya_…` (node credential), `lwyi_…` (invitation).
 */
export function generateToken(prefix: string, bytes = 32): string {
  return prefix + base62(randomBytes(bytes), Math.ceil((bytes * 8) / Math.log2(62)));
}

/** Non-secret hint to recognise a token in lists (`lwy_4fQx`). */
export function tokenHint(token: string): string {
  const separator = token.indexOf('_');
  return token.slice(0, separator + 5);
}
