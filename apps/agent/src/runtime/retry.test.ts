import { describe, expect, it, vi } from 'vitest';
import { withRetries } from './retry.js';

const options = (
  over: { delaysMs?: number[]; retryable?: () => boolean; signal?: AbortSignal } = {},
) => ({
  delaysMs: [0, 0, 0] as readonly number[],
  retryable: (): boolean => true,
  onRetry: vi.fn<(retry: number, of: number, delayMs: number, error: unknown) => void>(),
  signal: new AbortController().signal,
  ...over,
});

describe('withRetries', () => {
  it('returns the first success without retrying', async () => {
    const opts = options();
    expect(await withRetries(async () => 'ok', opts)).toBe('ok');
    expect(opts.onRetry).not.toHaveBeenCalled();
  });

  it('retries up to the number of delays, then succeeds', async () => {
    let calls = 0;
    const opts = options();
    const result = await withRetries(async () => {
      if (++calls < 3) throw new Error(`fail ${calls}`);
      return calls;
    }, opts);
    expect(result).toBe(3);
    expect(opts.onRetry.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [1, 3, 0],
      [2, 3, 0],
    ]);
  });

  it('throws the last error after 1 + 3 attempts', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        throw new Error(`fail ${++calls}`);
      }, options()),
    ).rejects.toThrow('fail 4');
    expect(calls).toBe(4);
  });

  it('waits the delays in order', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const opts = options({ delaysMs: [2000, 5000, 10000] });
      const promise = withRetries(async () => {
        if (++calls < 4) throw new Error('x');
        return 'done';
      }, opts);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await promise).toBe('done');
      expect(opts.onRetry.mock.calls.map((c) => c[2])).toEqual([2000, 5000, 10000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry what is not retryable, nor after an abort', async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error('timeout');
        },
        options({ retryable: () => false }),
      ),
    ).rejects.toThrow('timeout');
    expect(calls).toBe(1);

    const controller = new AbortController();
    await expect(
      withRetries(
        async () => {
          controller.abort();
          throw new Error('x');
        },
        options({ signal: controller.signal }),
      ),
    ).rejects.toThrow('x');
  });

  it('stops waiting when aborted', async () => {
    const controller = new AbortController();
    const promise = withRetries(
      async () => {
        throw new Error('x');
      },
      options({ delaysMs: [60_000], signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('aborted');
  });
});
