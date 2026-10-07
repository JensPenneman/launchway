import { randomBytes } from 'node:crypto';
import { API_TOKEN_PATTERN, NODE_JOIN_TOKEN_PATTERN } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  createSecretBox,
  DecryptionError,
  deriveKey,
  generateToken,
  hashToken,
  safeEqual,
  tokenHint,
} from './crypto.js';

const masterKey = randomBytes(32);

describe('SecretBox (AES-256-GCM)', () => {
  const box = createSecretBox(masterKey);

  it('round-trips values, with and without context', () => {
    expect(box.decrypt(box.encrypt('hunter2'))).toBe('hunter2');
    expect(box.decrypt(box.encrypt('ünïcødé 日本語 €', 'env:app_1:KEY'), 'env:app_1:KEY')).toBe(
      'ünïcødé 日本語 €',
    );
    expect(box.decrypt(box.encrypt(''))).toBe('');
  });

  it('uses a fresh IV for every value', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
    expect(box.encrypt('same').split('.')).toHaveLength(4);
  });

  it('rejects a wrong context, a wrong key and tampered data', () => {
    const sealed = box.encrypt('secret', 'env:app_1:A');
    expect(() => box.decrypt(sealed, 'env:app_2:A')).toThrow(DecryptionError);
    expect(() => createSecretBox(randomBytes(32)).decrypt(sealed, 'env:app_1:A')).toThrow(
      DecryptionError,
    );
    const [version, iv, data, tag] = sealed.split('.') as [string, string, string, string];
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() =>
      box.decrypt([version, iv, flipped.toString('base64url'), tag].join('.'), 'env:app_1:A'),
    ).toThrow(DecryptionError);
    expect(() => box.decrypt('not-a-ciphertext')).toThrow(DecryptionError);
  });

  it('derives distinct keys per purpose', () => {
    expect(deriveKey(masterKey, 'secrets').equals(deriveKey(masterKey, 'cookies'))).toBe(false);
    expect(() => deriveKey(randomBytes(16), 'secrets')).toThrow(RangeError);
  });
});

describe('tokens', () => {
  it('generates prefixed base62 tokens of 43 characters', () => {
    expect(generateToken('lwy_')).toMatch(API_TOKEN_PATTERN);
    expect(generateToken('lwyn_')).toMatch(NODE_JOIN_TOKEN_PATTERN);
    expect(new Set(Array.from({ length: 100 }, () => generateToken('lwy_'))).size).toBe(100);
  });

  it('hashes deterministically with SHA-256', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares in constant time and shows only a short hint', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(tokenHint('lwy_4fQxABCDEFG')).toBe('lwy_4fQx');
  });
});
