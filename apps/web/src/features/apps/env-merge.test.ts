import type { EnvVar } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { mergeEnvForBulk } from './env-merge';

function variable(key: string, secret: boolean): EnvVar {
  return {
    id: 'env_01k70000000000000000000001',
    key,
    secret,
    value: secret ? null : 'x',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('mergeEnvForBulk', () => {
  it('keeps untouched keys, updates pasted ones and preserves secrecy', () => {
    const existing = [variable('KEEP', false), variable('TOKEN', true)];
    expect(
      mergeEnvForBulk(
        existing,
        [
          { key: 'TOKEN', value: 'new' },
          { key: 'NEW', value: '1' },
        ],
        false,
      ),
    ).toEqual([
      { key: 'KEEP', secret: false },
      { key: 'TOKEN', value: 'new', secret: true },
      { key: 'NEW', value: '1', secret: false },
    ]);
  });

  it('marks every pasted key secret on request', () => {
    expect(mergeEnvForBulk([], [{ key: 'A', value: '1' }], true)).toEqual([
      { key: 'A', value: '1', secret: true },
    ]);
  });
});
