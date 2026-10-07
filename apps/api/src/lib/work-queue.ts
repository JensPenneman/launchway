import { ProblemError } from './problem.js';

/**
 * Bounds concurrent CPU- and memory-heavy work (argon2): at most `concurrency` jobs run, at most
 * `maxQueued` wait, and further callers get `503 service-unavailable` at once instead of piling up
 * on libuv's thread pool, which file, DNS and crypto calls of every other request share.
 */
export function createWorkQueue(concurrency: number, maxQueued: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (running >= concurrency) {
      if (waiting.length >= maxQueued) {
        throw new ProblemError('service-unavailable', {
          detail: 'Too many sign-ins in progress; retry in a moment',
          headers: { 'Retry-After': '1' },
        });
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}
