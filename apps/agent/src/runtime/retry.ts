/** Waits before each retry of a failed image pull or build (ADR 0020). */
export const IMAGE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

export interface RetryOptions {
  /** One entry per retry: the wait before it. */
  delaysMs: readonly number[];
  /** Whether a failure may be retried; the others are thrown at once. */
  retryable: (error: unknown) => boolean;
  /** Called before each wait, with the number of the retry (from 1) and the retries allowed. */
  onRetry: (retry: number, of: number, delayMs: number, error: unknown) => void;
  signal: AbortSignal;
}

/** Waits `ms`, or throws when the signal aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `task`; when it fails with a retryable error it runs it again after each of `delaysMs`.
 * The error of the last attempt is thrown once the retries are used up.
 */
export async function withRetries<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await task();
    } catch (error) {
      const delay = options.delaysMs[retry];
      if (delay === undefined || options.signal.aborted || !options.retryable(error)) throw error;
      options.onRetry(retry + 1, options.delaysMs.length, delay, error);
      await sleep(delay, options.signal);
    }
  }
}
