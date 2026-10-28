import { describe, expect, it, vi } from 'vitest';
import { WorkQueue } from './work-queue.js';

/** A task that records its start and end and waits for `finish()`. */
function task(log: string[], name: string) {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    run: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
    },
    finish: () => finish(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WorkQueue', () => {
  it('runs shared tasks side by side, never inside the call that adds them', async () => {
    const log: string[] = [];
    const queue = new WorkQueue(() => {});
    const [a, b] = [task(log, 'a'), task(log, 'b')];
    queue.shared(a.run);
    queue.shared(b.run);
    expect(log).toEqual([]);
    await settle();
    expect(log).toEqual(['start a', 'start b']);
    b.finish();
    a.finish();
    await queue.idle();
    expect(log).toEqual(['start a', 'start b', 'end b', 'end a']);
  });

  it('runs an exclusive task alone: after the tasks before it, before the tasks after it', async () => {
    const log: string[] = [];
    const queue = new WorkQueue(() => {});
    const [a, sweep, b, c] = [task(log, 'a'), task(log, 'sweep'), task(log, 'b'), task(log, 'c')];
    queue.shared(a.run);
    queue.exclusive(sweep.run);
    queue.shared(b.run);
    queue.shared(c.run);
    await settle();
    // b does not overtake the waiting sweep, though only shared tasks run.
    expect(log).toEqual(['start a']);
    a.finish();
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start sweep']);
    sweep.finish();
    await settle();
    expect(log.slice(3)).toEqual(['end sweep', 'start b', 'start c']);
    b.finish();
    c.finish();
    await queue.idle();
  });

  it('passes failures to its handler and goes on', async () => {
    const onError = vi.fn();
    const queue = new WorkQueue(onError);
    const ran: string[] = [];
    queue.exclusive(() => Promise.reject(new Error('sweep failed')));
    queue.shared(async () => {
      ran.push('run');
    });
    await queue.idle();
    expect(onError).toHaveBeenCalledWith(new Error('sweep failed'));
    expect(ran).toEqual(['run']);
  });

  it('is idle once the tasks added meanwhile ended too', async () => {
    const queue = new WorkQueue(() => {});
    const ran: string[] = [];
    queue.shared(async () => {
      ran.push('first');
      queue.shared(async () => {
        await settle();
        ran.push('second');
      });
    });
    await queue.idle();
    expect(ran).toEqual(['first', 'second']);
  });
});
