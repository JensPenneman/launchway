import { describe, expect, it } from 'vitest';
import {
  IMAGE_RETRY_BUDGET_MS,
  IMAGE_RETRY_LIMIT,
  imageRetryDelayMs,
  isAutomaticTrigger,
  nextImageRetry,
} from './dispatcher.js';
import { failureMessage, MANUAL_IMAGE_HINT } from './sink.js';

const MINUTE = 60_000;

describe('image retry backoff', () => {
  it('waits 1, 2, 4, 8 and then 15 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => imageRetryDelayMs(n) / MINUTE)).toEqual([
      1, 2, 4, 8, 15, 15, 15, 15,
    ]);
  });

  it('gives up once the waits would exceed 60 minutes', () => {
    expect(IMAGE_RETRY_LIMIT).toBe(7);
    let total = 0;
    for (let n = 0; n < IMAGE_RETRY_LIMIT; n += 1) total += imageRetryDelayMs(n);
    expect(total).toBe(IMAGE_RETRY_BUDGET_MS);
  });

  it('schedules the next retry of automatic deployments only', () => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    expect(nextImageRetry('auto', 0, now)).toEqual({
      retryCount: 1,
      nextAttemptAt: new Date('2026-10-07T12:01:00.000Z'),
    });
    expect(nextImageRetry('auto', 3, now)).toEqual({
      retryCount: 4,
      nextAttemptAt: new Date('2026-10-07T12:08:00.000Z'),
    });
    expect(nextImageRetry('auto', 6, now)?.retryCount).toBe(7);
    expect(nextImageRetry('auto', 7, now)).toBeNull();
    expect(nextImageRetry('manual', 0, now)).toBeNull();
  });

  it('treats every trigger but manual as automatic', () => {
    expect(isAutomaticTrigger('auto')).toBe(true);
    expect(isAutomaticTrigger('manual')).toBe(false);
  });
});

describe('failureMessage', () => {
  const error = 'Image not found in the registry (exit 18): docker compose pull';

  it('passes other failures through', () => {
    expect(failureMessage({ trigger: 'manual', retryCount: 0 }, 'build', error)).toBe(error);
    expect(failureMessage({ trigger: 'auto', retryCount: 0 }, null, error)).toBe(error);
  });

  it('suggests deploying again for manual deployments', () => {
    expect(failureMessage({ trigger: 'manual', retryCount: 0 }, 'image-not-found', error)).toBe(
      `${MANUAL_IMAGE_HINT}\n${error}`,
    );
  });

  it('says how long an automatic deployment waited before giving up', () => {
    expect(failureMessage({ trigger: 'auto', retryCount: 7 }, 'image-not-found', error)).toBe(
      `Gave up after 7 retries over 60 minutes: the image still does not exist in the registry.\n${error}`,
    );
  });
});
