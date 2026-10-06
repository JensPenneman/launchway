import { StringDecoder } from 'node:string_decoder';

/** Longest log line the protocol accepts (`LogLine.line`, `AppLogLine.line`). */
export const MAX_LINE_LENGTH = 16_384;

/**
 * Splits a byte stream into lines. Handles chunks that end mid-line or mid-character, treats
 * `\n`, `\r\n` and a lone `\r` (progress updates) as line ends, and wraps lines longer than
 * `maxLength` so a stream without newlines cannot grow the buffer without bound.
 */
export class LineSplitter {
  readonly #onLine: (line: string) => void;
  readonly #maxLength: number;
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';
  #pendingCr = false;

  constructor(onLine: (line: string) => void, maxLength = MAX_LINE_LENGTH) {
    this.#onLine = onLine;
    this.#maxLength = maxLength;
  }

  push(chunk: Buffer | string): void {
    this.#consume(typeof chunk === 'string' ? chunk : this.#decoder.write(chunk));
  }

  /** Flushes the last unterminated line. */
  end(): void {
    this.#consume(this.#decoder.end());
    if (this.#buffer.length > 0) this.#onLine(this.#buffer);
    this.#buffer = '';
  }

  #consume(text: string): void {
    for (const char of text) {
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (char === '\n') continue;
      }
      if (char === '\n' || char === '\r') {
        this.#onLine(this.#buffer);
        this.#buffer = '';
        this.#pendingCr = char === '\r';
        continue;
      }
      this.#buffer += char;
      if (this.#buffer.length >= this.#maxLength) {
        this.#onLine(this.#buffer);
        this.#buffer = '';
      }
    }
  }
}

export interface BatcherOptions {
  intervalMs?: number;
  maxBatch?: number;
}

/**
 * Collects items and flushes them at most every `intervalMs` (100 ms by default) or as soon as
 * `maxBatch` items are pending, so log lines leave as few, bounded messages.
 */
export class Batcher<T> {
  readonly #flush: (items: T[]) => void;
  readonly #intervalMs: number;
  readonly #maxBatch: number;
  #items: T[] = [];
  #timer: NodeJS.Timeout | undefined;

  constructor(flush: (items: T[]) => void, options: BatcherOptions = {}) {
    this.#flush = flush;
    this.#intervalMs = options.intervalMs ?? 100;
    this.#maxBatch = options.maxBatch ?? 500;
  }

  add(item: T): void {
    this.#items.push(item);
    if (this.#items.length >= this.#maxBatch) {
      this.flush();
      return;
    }
    this.#timer ??= setTimeout(() => this.flush(), this.#intervalMs);
  }

  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#items.length === 0) return;
    const items = this.#items;
    this.#items = [];
    this.#flush(items);
  }
}

/** Token bucket: allows `ratePerSecond` events on average with bursts up to `burst`. */
export class RateLimiter {
  readonly #rate: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #last: number;

  constructor(ratePerSecond: number, burst = ratePerSecond, now: () => number = Date.now) {
    this.#rate = ratePerSecond;
    this.#burst = burst;
    this.#now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  tryTake(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) / 1000) * this.#rate);
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** Keeps the last `size` items (for failure summaries). */
export class Tail<T> {
  readonly #size: number;
  readonly #items: T[] = [];

  constructor(size: number) {
    this.#size = size;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.#size) this.#items.shift();
  }

  values(): T[] {
    return [...this.#items];
  }
}
