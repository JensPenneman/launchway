import { describe, expect, it } from 'vitest';
import { imageRetryLabel } from './image-retry';

const iso = (date: Date) => date.toISOString();

describe('imageRetryLabel', () => {
  const waiting = {
    status: 'queued' as const,
    failureReason: 'image-not-found' as const,
    retryCount: 2,
    nextAttemptAt: '2026-10-07T12:05:00.000Z',
  };

  it('describes a pending image retry', () => {
    expect(imageRetryLabel(waiting, iso)).toBe(
      'Waiting for image, retry 2 at 2026-10-07T12:05:00.000Z',
    );
  });

  it('is null for deployments that are not waiting for an image', () => {
    expect(imageRetryLabel({ ...waiting, status: 'building' }, iso)).toBeNull();
    expect(imageRetryLabel({ ...waiting, status: 'failed' }, iso)).toBeNull();
    expect(imageRetryLabel({ ...waiting, retryCount: 0 }, iso)).toBeNull();
    expect(imageRetryLabel({ ...waiting, nextAttemptAt: null }, iso)).toBeNull();
    expect(imageRetryLabel({ ...waiting, failureReason: null }, iso)).toBeNull();
  });
});
