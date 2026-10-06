export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 30_000 };

/**
 * Reconnect delay for the given attempt (0-based): exponential growth capped at `maxMs`, with
 * "equal jitter" (half fixed, half random) so many agents do not reconnect in lockstep.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxMs, options.initialMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
