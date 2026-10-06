import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

export interface SseMessage {
  /** SSE `event:` name (see SSE_EVENTS in @slipway/contracts). */
  event: string;
  /** Serialized as JSON into `data:`. */
  data: unknown;
  /** SSE `id:` (enables Last-Event-ID on reconnect). */
  id?: string;
}

export interface SseOptions {
  /** Ends the stream, e.g. `deps.lifecycle.signal` so streams close on shutdown. */
  signal?: AbortSignal;
  /** Interval of `: keep-alive` comments that keep proxies from closing idle streams. */
  heartbeatMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Streams `source` as Server-Sent Events (`GET /events`, `.../logs?follow=true`). The source
 * receives an AbortSignal that fires when the client disconnects, the server shuts down or the
 * caller's signal aborts; the stream ends when the source completes.
 */
export function sseResponse(
  c: Context,
  source: (signal: AbortSignal) => AsyncIterable<SseMessage>,
  options: SseOptions = {},
): Response {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(
    c,
    async (stream) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      stream.onAbort(abort);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const heartbeat = setInterval(() => {
        stream.write(': keep-alive\n\n').catch(abort);
      }, heartbeatMs);
      try {
        for await (const message of source(controller.signal)) {
          if (controller.signal.aborted) break;
          await stream.writeSSE({
            event: message.event,
            data: JSON.stringify(message.data),
            ...(message.id === undefined ? {} : { id: message.id }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        options.signal?.removeEventListener('abort', abort);
      }
    },
    async (error) => {
      options.onError?.(error);
    },
  );
}
