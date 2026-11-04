/** Waits before each retry of a failed image pull or build (ADR 0020). */
export const IMAGE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * Output of a failed pull or build that a new attempt can fix: the daemon lost the lease of
 * content that another pull fetched at the same time, or the registry or the network hiccuped.
 * Anything else (a broken Dockerfile, a missing image, denied access) fails the same way again.
 */
const TRANSIENT_IMAGE_ERROR = new RegExp(
  [
    'unable to lease content',
    'lease does not exist',
    'i/o timeout',
    'TLS handshake timeout',
    'connection reset',
    'unexpected EOF',
    'toomanyrequests',
    'too many requests',
    '\\b5\\d\\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)',
    'unexpected HTTP status: 5\\d\\d',
  ].join('|'),
  'i',
);

export function isTransientImageError(output: readonly string[]): boolean {
  return TRANSIENT_IMAGE_ERROR.test(output.join('\n'));
}

export interface RetryOptions {
  /** One entry per retry: the wait before it. */
  delaysMs: readonly number[];
  /** Time all attempts and waits share; a retry that would not fit is not made. */
  budgetMs: number;
  now?: () => number;
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
export async function withRetries<T>(
  task: (remainingMs: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const started = now();
  const remaining = () => options.budgetMs - (now() - started);
  for (let retry = 0; ; retry++) {
    try {
      return await task(Math.max(1, remaining()));
    } catch (error) {
      const delay = options.delaysMs[retry];
      if (
        delay === undefined ||
        options.signal.aborted ||
        !options.retryable(error) ||
        remaining() <= delay
      ) {
        throw error;
      }
      options.onRetry(retry + 1, options.delaysMs.length, delay, error);
      await sleep(delay, options.signal);
    }
  }
}
