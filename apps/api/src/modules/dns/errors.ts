import { ProblemError } from '../../lib/problem.js';
import { DnsProviderError } from './providers/types.js';

/** Maps a provider failure to the problem the API answers with. */
export function providerProblem(error: DnsProviderError): ProblemError {
  const cause = { cause: error };
  switch (error.reason) {
    case 'unauthorized':
    case 'forbidden':
      return new ProblemError('upstream-failed', {
        ...cause,
        detail: `${error.message}. Update the DNS provider account credentials.`,
      });
    case 'rate-limited':
      return new ProblemError('rate-limited', {
        ...cause,
        detail: error.message,
        ...(error.retryAfter === undefined
          ? {}
          : { headers: { 'Retry-After': String(error.retryAfter) } }),
      });
    case 'not-found':
      return new ProblemError('not-found', { ...cause, detail: error.message });
    case 'conflict':
      return new ProblemError('conflict', { ...cause, detail: error.message });
    case 'invalid':
      return new ProblemError('bad-request', { ...cause, detail: error.message });
    case 'unavailable':
      return new ProblemError('upstream-failed', { ...cause, detail: error.message });
  }
}

/** Runs a provider call and turns `DnsProviderError` into a problem. */
export async function callProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DnsProviderError) throw providerProblem(error);
    throw error;
  }
}
