import { type LogLine, SSE_EVENTS } from '@launchway/contracts';
import type { EventBus } from './event-bus.js';
import type { SseMessage } from './sse.js';

/** What a live log subscriber receives: lines, status changes and the end of the output. */
export type LogStreamItem<S extends string> =
  | { readonly kind: 'log'; readonly line: LogLine }
  | { readonly kind: 'status'; readonly status: S }
  | { readonly kind: 'end'; readonly status: S };

type Listener<S extends string> = (item: LogStreamItem<S>) => void;

/**
 * In-process fan-out of live output (log lines and status changes) of deployments or check runs,
 * from the sink that stores it to `GET .../logs?follow=true` subscribers. Persisted lines are the
 * source of truth; a hub only carries what happens while a client is connected.
 */
export interface LogHub<S extends string> {
  publish(id: string, item: LogStreamItem<S>): void;
  subscribe(id: string, listener: Listener<S>): () => void;
}

function createLogHub<S extends string>(): LogHub<S> {
  const listeners = new Map<string, Set<Listener<S>>>();
  return {
    publish(id, item) {
      for (const listener of listeners.get(id) ?? []) {
        try {
          listener(item);
        } catch {
          // A failing subscriber must not break the sink.
        }
      }
    },
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      };
    },
  };
}

const hubs = new WeakMap<EventBus, Map<string, LogHub<string>>>();

/**
 * The hub named `name` shared by the sink and the routes of one process. It is keyed by the event
 * bus so that every holder of the same `Deps` (or of a copy with the same bus) sees the same hub.
 */
export function logHubFor<S extends string>(events: EventBus, name: string): LogHub<S> {
  let named = hubs.get(events);
  if (!named) {
    named = new Map();
    hubs.set(events, named);
  }
  let hub = named.get(name);
  if (!hub) {
    hub = createLogHub<string>();
    named.set(name, hub);
  }
  return hub as LogHub<S>;
}

const HISTORY_BATCH = 1000;
const MAX_BUFFERED_ITEMS = 10_000;

/** Where `logStream` reads the stored output and the state of one deployment or check run. */
export interface LogStreamSource<S extends string> {
  readonly hub: LogHub<S>;
  readonly id: string;
  /** Keep streaming live output while `live(status)` holds. */
  readonly follow: boolean;
  /** Only lines with seq > after. */
  readonly after: number | undefined;
  /** Stored lines with seq > `after`, ascending, at most `limit`. */
  history(after: number, limit: number): Promise<LogLine[]>;
  /** The current status (throws when the resource is gone). */
  status(): Promise<S>;
  /** Whether more output may follow in this status. */
  live(status: S): boolean;
}

/**
 * SSE source of a log: the stored history after `after` (`log` events, SSE id = seq), then, with
 * `follow` and while the output may grow, live `log` and `status` events. Ends with `end`
 * ({ status }) once nothing more follows, or when `signal` aborts (no `end` then).
 */
export async function* logStream<S extends string>(
  source: LogStreamSource<S>,
  signal: AbortSignal,
): AsyncGenerator<SseMessage> {
  const queue: LogStreamItem<S>[] = [];
  let wake: (() => void) | undefined;
  const onAbort = () => wake?.();
  signal.addEventListener('abort', onAbort);
  // Subscribe before reading history so nothing falls between the two; seq dedupes.
  const unsubscribe = source.follow
    ? source.hub.subscribe(source.id, (item) => {
        queue.push(item);
        if (queue.length > MAX_BUFFERED_ITEMS) queue.shift();
        wake?.();
      })
    : () => {};
  let last = source.after ?? -1;
  async function* history(): AsyncGenerator<SseMessage> {
    for (;;) {
      const lines = await source.history(last, HISTORY_BATCH);
      for (const line of lines) {
        if (signal.aborted) return;
        last = line.seq;
        yield { event: SSE_EVENTS.log, id: String(line.seq), data: line };
      }
      if (lines.length < HISTORY_BATCH) break;
    }
  }
  try {
    yield* history();
    if (signal.aborted) return;
    const current = await source.status();
    if (!source.follow || !source.live(current)) {
      // Lines stored between the history read and the status check (the final ones).
      yield* history();
      if (signal.aborted) return;
      yield { event: SSE_EVENTS.end, data: { status: current } };
      return;
    }
    while (!signal.aborted) {
      const item = queue.shift();
      if (!item) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      if (item.kind === 'log') {
        if (item.line.seq <= last) continue;
        last = item.line.seq;
        yield { event: SSE_EVENTS.log, id: String(item.line.seq), data: item.line };
      } else if (item.kind === 'status') {
        yield { event: SSE_EVENTS.status, data: { status: item.status } };
      } else {
        yield { event: SSE_EVENTS.end, data: { status: item.status } };
        return;
      }
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}
