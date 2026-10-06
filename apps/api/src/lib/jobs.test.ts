import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startJob } from './jobs.js';

const logger = pino({ level: 'silent' });

describe('startJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on the interval plus jitter and stops on the signal', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => 'done');
    startJob({
      name: 't',
      intervalMs: 1_000,
      jitterMs: 100,
      initialDelayMs: 500,
      random: () => 0.5,
      signal: controller.signal,
      logger,
      run,
    });
    await vi.advanceTimersByTimeAsync(549);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(controller.signal, 'schedule');
    await vi.advanceTimersByTimeAsync(1_050);
    expect(run).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('serializes manual runs and propagates their errors', async () => {
    const order: string[] = [];
    let call = 0;
    const job = startJob({
      name: 't',
      intervalMs: 1_000,
      schedule: false,
      signal: new AbortController().signal,
      logger,
      run: async (_signal, trigger) => {
        const n = ++call;
        order.push(`start ${n} ${trigger}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        order.push(`end ${n}`);
        if (n === 2) throw new Error('second failed');
        return n;
      },
    });
    const first = job.runNow();
    const second = job.runNow();
    const third = job.runNow();
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow('second failed');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual([
      'start 1 manual',
      'end 1',
      'start 2 manual',
      'end 2',
      'start 3 manual',
      'end 3',
    ]);
  });

  it('logs scheduled failures and keeps going', async () => {
    const error = vi.fn();
    const failing = { ...logger, error, debug: vi.fn() } as unknown as typeof logger;
    const run = vi.fn(async () => {
      throw new Error('nope');
    });
    startJob({
      name: 't',
      intervalMs: 100,
      jitterMs: 0,
      signal: new AbortController().signal,
      logger: failing,
      run,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ job: 't' }), 'job failed');
  });

  it('skips a beat while a manual run is in progress', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const job = startJob({
      name: 't',
      intervalMs: 100,
      jitterMs: 0,
      signal: new AbortController().signal,
      logger,
      run,
    });
    const manual = job.runNow();
    await vi.advanceTimersByTimeAsync(150);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await manual;
    job.stop();
  });
});
