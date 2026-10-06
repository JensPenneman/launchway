import { describe, expect, it } from 'vitest';
import { AppId, generateId, ID_PREFIXES, isTypeId, typeId, UserId } from './ids.js';

describe('type ids', () => {
  it('uses exactly the prefixes from the specification', () => {
    expect(Object.values(ID_PREFIXES).sort()).toEqual(
      [
        'app',
        'aud',
        'dep',
        'dom',
        'env',
        'gh',
        'inv',
        'node',
        'pk',
        'prov',
        'rt',
        'sess',
        'tok',
        'user',
        'zone',
      ].sort(),
    );
  });

  it.each(Object.values(ID_PREFIXES))('generates ids that validate for prefix %s', (prefix) => {
    const id = generateId(prefix);
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(typeId(prefix).safeParse(id).success).toBe(true);
    expect(isTypeId(prefix, id)).toBe(true);
  });

  it('generates time-ordered ids', () => {
    const ids = Array.from({ length: 50 }, () => generateId('dep'));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects ids with another prefix or malformed suffix', () => {
    const appId = generateId('app');
    expect(UserId.safeParse(appId).success).toBe(false);
    expect(AppId.safeParse(appId.toUpperCase()).success).toBe(false);
    expect(AppId.safeParse(`${appId}x`).success).toBe(false);
    expect(AppId.safeParse('app_81h455vb4pex5vsknk084sn02q').success).toBe(false); // first char > 7
    expect(AppId.safeParse('app_01h455vb4pex5vsknk084sn0iq').success).toBe(false); // 'i' not in alphabet
    expect(isTypeId('app', 42)).toBe(false);
  });
});
