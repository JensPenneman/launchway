import { describe, expect, it } from 'vitest';
import { diffSummary } from './service.js';

describe('diffSummary', () => {
  it('records only changed keys and redacts secret ones', () => {
    const before = { publicUrl: null, acmeEmail: 'a@example.com', token: 'old', same: 1 };
    const after = {
      publicUrl: 'https://x.example.com',
      acmeEmail: 'a@example.com',
      token: 'new',
      same: 1,
    };
    expect(
      diffSummary(before, after, ['publicUrl', 'acmeEmail', 'token', 'same'], ['token']),
    ).toEqual({
      publicUrl: { from: null, to: 'https://x.example.com' },
      token: { from: '[redacted]', to: '[redacted]' },
    });
  });
});
