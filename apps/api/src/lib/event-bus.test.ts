import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEventBus } from './event-bus.js';
import { decodeCursor, encodeCursor } from './pagination.js';
import { ProblemError } from './problem.js';

describe('event bus', () => {
  it('delivers published events to subscribers with increasing ids', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) =>
      seen.push(`${event.id}:${event.topic}.${event.action}`),
    );
    bus.publish({ topic: 'apps', action: 'created', resourceId: 'app_1' });
    unsubscribe();
    bus.publish({ topic: 'apps', action: 'deleted', resourceId: 'app_1' });
    expect(seen).toEqual(['1:apps.created']);
  });

  it('streams events until the signal aborts', async () => {
    const bus = createEventBus();
    const controller = new AbortController();
    const received: string[] = [];
    const consumer = (async () => {
      for await (const event of bus.stream(controller.signal)) {
        received.push(event.topic);
        if (received.length === 2) controller.abort();
      }
    })();
    await Promise.resolve();
    bus.publish({ topic: 'nodes', action: 'updated', resourceId: null });
    bus.publish({ topic: 'settings', action: 'updated', resourceId: null });
    await consumer;
    expect(received).toEqual(['nodes', 'settings']);
  });
});

describe('cursors', () => {
  const Position = z.object({ createdAt: z.string(), id: z.string() });

  it('round-trips keyset positions', () => {
    const cursor = encodeCursor({ createdAt: '2026-10-06T12:00:00.000Z', id: 'app_1' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, Position)).toEqual({
      createdAt: '2026-10-06T12:00:00.000Z',
      id: 'app_1',
    });
  });

  it('rejects malformed cursors with a 400 problem', () => {
    expect(() => decodeCursor('bm9wZQ', Position)).toThrow(ProblemError);
  });
});
