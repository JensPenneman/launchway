import type { EventAction, EventTopic, PlatformEvent } from '@slipway/contracts';

export interface PublishInput {
  topic: EventTopic;
  action: EventAction;
  resourceId: string | null;
  /** Small, non-secret hints (e.g. a new status). */
  data?: Record<string, unknown>;
}

/**
 * In-process change feed behind `GET /api/v1/events`. Publish *after* the database transaction
 * committed so subscribers never see uncommitted state.
 */
export interface EventBus {
  publish(input: PublishInput): PlatformEvent;
  subscribe(listener: (event: PlatformEvent) => void): () => void;
  /** Async iterator of events until `signal` aborts; slow consumers drop the oldest events. */
  stream(signal: AbortSignal, bufferSize?: number): AsyncIterable<PlatformEvent>;
}

export function createEventBus(): EventBus {
  const listeners = new Set<(event: PlatformEvent) => void>();
  let sequence = 0;

  const subscribe = (listener: (event: PlatformEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    publish(input) {
      sequence += 1;
      const event: PlatformEvent = {
        id: String(sequence),
        topic: input.topic,
        action: input.action,
        resourceId: input.resourceId,
        at: new Date().toISOString(),
        ...(input.data === undefined ? {} : { data: input.data }),
      };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must not break publishers.
        }
      }
      return event;
    },
    subscribe,
    async *stream(signal, bufferSize = 1000) {
      const queue: PlatformEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = subscribe((event) => {
        queue.push(event);
        if (queue.length > bufferSize) queue.shift();
        wake?.();
      });
      const onAbort = () => wake?.();
      signal.addEventListener('abort', onAbort);
      try {
        while (!signal.aborted) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
