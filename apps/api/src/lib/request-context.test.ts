import { describe, expect, it } from 'vitest';
import { redactPath } from './request-context.js';

describe('redactPath', () => {
  it('keeps invitation tokens out of the access log', () => {
    const token = `slpi_${'aB3'.repeat(14)}x`;
    expect(redactPath(`/api/v1/invitations/${token}/accept`)).toBe(
      '/api/v1/invitations/slpi_[redacted]/accept',
    );
    expect(redactPath('/api/v1/apps/app_01jbh8m4x2f8k9z0a1b2c3d4e5')).toBe(
      '/api/v1/apps/app_01jbh8m4x2f8k9z0a1b2c3d4e5',
    );
  });
});
