import type { Logger } from 'pino';

export type JobTrigger = 'schedule' | 'manual';

export interface JobOptions<T> {
  /** Name used in logs. */
  readonly name: string;
  /** Pause between the end of one scheduled run and the start of the next. */
  readonly intervalMs: number;
  /** Random extra delay (0..jitterMs) added to every pause. Default: 10% of the interval. */
  readonly jitterMs?: number;
  /** Delay before the first scheduled run. Default: one interval (plus jitter). */
  readonly initialDelayMs?: number;
  /** When false, nothing is scheduled; `runNow()` still works (tests, disabled jobs). */
  readonly schedule?: boolean;
  /** Stops the schedule when aborted (`deps.lifecycle.signal`); a run in progress finishes. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** `trigger` tells scheduled runs from `runNow()` calls. */
  readonly run: (signal: AbortSignal, trigger: JobTrigger) => Promise<T>;
  /** Overridable for tests. */
  readonly random?: () => number;
}

export interface Job<T> {
  /**
   * Runs the job now, after any run in progress (runs never overlap). Rejects when the run
   * throws, unlike scheduled runs, whose errors are logged.
   */
  runNow(): Promise<T>;
  /** Stops scheduling further runs. */
  stop(): void;
}

/**
 * A periodic background job: interval + jitter, serialized runs, stops on the lifecycle signal,
 * and scheduled-run errors are logged instead of thrown. Timers are unref'd, so a job never keeps
 * the process alive.
 */
export function startJob<T>(options: JobOptions<T>): Job<T> {
  const { name, intervalMs, signal, logger } = options;
  const jitterMs = options.jitterMs ?? Math.round(intervalMs / 10);
  const random = options.random ?? Math.random;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = !(options.schedule ?? true) || signal.aborted;

  const enqueue = (trigger: JobTrigger): Promise<T> => {
    pending += 1;
    const result = tail.then(() => options.run(signal, trigger));
    const settled = result.finally(() => {
      pending -= 1;
    });
    tail = settled.catch(() => undefined);
    return settled;
  };

  const delay = (base: number) => base + Math.floor(random() * (jitterMs + 1));

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref();
  };

  function tick(): void {
    timer = undefined;
    if (stopped) return;
    // A manual run is in progress or queued: skip this beat instead of piling up runs.
    if (pending > 0) {
      schedule(delay(intervalMs));
      return;
    }
    const startedAt = Date.now();
    enqueue('schedule')
      .then(
        () => logger.debug({ job: name, durationMs: Date.now() - startedAt }, 'job finished'),
        (error: unknown) => logger.error({ err: error, job: name }, 'job failed'),
      )
      .finally(() => schedule(delay(intervalMs)));
  }

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  signal.addEventListener('abort', stop, { once: true });
  schedule(delay(options.initialDelayMs ?? intervalMs));
  return { runNow: () => enqueue('manual'), stop };
}
