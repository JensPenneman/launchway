import { afterEach, describe, expect, it, vi } from 'vitest';
import { Batcher, LineSplitter, RateLimiter, Tail } from './lines.js';

function split(chunks: (string | Buffer)[], maxLength?: number): string[] {
  const lines: string[] = [];
  const splitter = new LineSplitter((line) => lines.push(line), maxLength);
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return lines;
}

describe('LineSplitter', () => {
  it('joins partial chunks and handles LF, CRLF and CR line ends', () => {
    expect(split(['he', 'llo\nwor', 'ld\r', '\nnext\rprogress 50%\rdone'])).toEqual([
      'hello',
      'world',
      'next',
      'progress 50%',
      'done',
    ]);
  });

  it('keeps empty lines and flushes the unterminated rest on end', () => {
    expect(split(['a\n\nb'])).toEqual(['a', '', 'b']);
    expect(split(['a\n'])).toEqual(['a']);
  });

  it('decodes multi-byte characters split across chunks', () => {
    const bytes = Buffer.from('héllo ✓\n', 'utf8');
    expect(split([bytes.subarray(0, 2), bytes.subarray(2, 8), bytes.subarray(8)])).toEqual([
      'héllo ✓',
    ]);
  });

  it('wraps lines longer than the limit', () => {
    expect(split(['abcdefgh\n'], 3)).toEqual(['abc', 'def', 'gh']);
  });
});

describe('Batcher', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes after the interval', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const batcher = new Batcher<number>((items) => batches.push(items), { intervalMs: 100 });
    batcher.add(1);
    batcher.add(2);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(batches).toEqual([[1, 2]]);
    batcher.add(3);
    vi.advanceTimersByTime(99);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([[1, 2], [3]]);
  });

  it('flushes immediately when the batch is full and on demand', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const batcher = new Batcher<number>((items) => batches.push(items), { maxBatch: 2 });
    batcher.add(1);
    batcher.add(2);
    batcher.add(3);
    expect(batches).toEqual([[1, 2]]);
    batcher.flush();
    batcher.flush();
    expect(batches).toEqual([[1, 2], [3]]);
  });
});

describe('RateLimiter', () => {
  it('allows bursts and refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(10, 2, () => now);
    expect([limiter.tryTake(), limiter.tryTake(), limiter.tryTake()]).toEqual([true, true, false]);
    now = 100;
    expect([limiter.tryTake(), limiter.tryTake()]).toEqual([true, false]);
  });
});

describe('Tail', () => {
  it('keeps the last items', () => {
    const tail = new Tail<number>(2);
    for (const n of [1, 2, 3]) tail.push(n);
    expect(tail.values()).toEqual([2, 3]);
  });
});
