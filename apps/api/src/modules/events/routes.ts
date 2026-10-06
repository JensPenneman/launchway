import { createRoute } from '@hono/zod-openapi';
import { PlatformEvent, SSE_EVENTS } from '@slipway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requireRole } from '../../lib/auth-context.js';
import type { EventBus } from '../../lib/event-bus.js';
import { AUTHENTICATED, problemResponses } from '../../lib/openapi.js';
import { type SseMessage, sseResponse } from '../../lib/sse.js';

/** Interval of `: keep-alive` comments on the change feed. */
export const EVENTS_HEARTBEAT_MS = 15_000;

const streamEvents = createRoute({
  method: 'get',
  path: '/events',
  operationId: 'streamEvents',
  tags: ['Events'],
  summary: 'Platform change feed (Server-Sent Events)',
  description:
    'Each change is sent as `event: platform` with a PlatformEvent as `data` and its id as the SSE ' +
    '`id`. A `: keep-alive` comment follows every 15 s of silence. The stream ends when the server ' +
    'shuts down; clients reconnect and refetch.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: {
      description: 'Event stream',
      content: { 'text/event-stream': { schema: PlatformEvent } },
    },
    ...problemResponses(401, 403),
  },
});

async function* platformMessages(events: EventBus, signal: AbortSignal): AsyncIterable<SseMessage> {
  for await (const event of events.stream(signal)) {
    yield { event: SSE_EVENTS.platform, data: event, id: event.id };
  }
}

export function registerEventsRoutes(api: Api, deps: Deps): void {
  api.openapi(streamEvents, (c) =>
    sseResponse(c, (signal) => platformMessages(deps.events, signal), {
      signal: deps.lifecycle.signal,
      heartbeatMs: EVENTS_HEARTBEAT_MS,
      onError: (err) => c.get('logger').warn({ err }, 'event stream failed'),
    }),
  );
}
