import type { LogLine } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { createEventBus } from './event-bus.js';
import { type LogHub, logHubFor, logStream } from './log-stream.js';
import type { SseMessage } from './sse.js';

type Status = 'running' | 'done';

const line = (seq: number): LogLine => ({
  seq,
  timestamp: '2026-10-27T10:00:00.000Z',
  stream: 'stdout',
  line: `line ${seq}`,
});

function source(hub: LogHub<Status>, stored: LogLine[], status: () => Status, follow: boolean) {
  return {
    hub,
    id: 'run-1',
    follow,
    after: undefined,
    history: async (after: number, limit: number) =>
      stored.filter((l) => l.seq > after).slice(0, limit),
    status: async () => status(),
    live: (s: Status) => s === 'running',
  };
}

async function collect(stream: AsyncIterable<SseMessage>): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

describe('log hubs', () => {
  it('shares one hub per event bus and name', () => {
    const events = createEventBus();
    expect(logHubFor(events, 'checks')).toBe(logHubFor(events, 'checks'));
    expect(logHubFor(events, 'checks')).not.toBe(logHubFor(events, 'deployments'));
    expect(logHubFor(createEventBus(), 'checks')).not.toBe(logHubFor(events, 'checks'));
  });
});

describe('logStream', () => {
  it('sends the history and ends at once when nothing more follows', async () => {
    const hub = logHubFor<Status>(createEventBus(), 'test');
    const messages = await collect(
      logStream(
        source(hub, [line(0), line(1)], () => 'done', true),
        new AbortController().signal,
      ),
    );
    expect(messages).toEqual([
      { event: 'log', id: '0', data: line(0) },
      { event: 'log', id: '1', data: line(1) },
      { event: 'end', data: { status: 'done' } },
    ]);
  });

  it('follows live lines and status changes until the end, without repeating lines', async () => {
    const hub = logHubFor<Status>(createEventBus(), 'test');
    const stream = logStream(
      source(hub, [line(0)], () => 'running', true),
      new AbortController().signal,
    );
    const done = collect(stream);
    await new Promise((resolve) => setTimeout(resolve, 10));
    hub.publish('run-1', { kind: 'log', line: line(0) });
    hub.publish('run-1', { kind: 'log', line: line(1) });
    hub.publish('other-run', { kind: 'log', line: line(7) });
    hub.publish('run-1', { kind: 'status', status: 'done' });
    hub.publish('run-1', { kind: 'end', status: 'done' });
    expect(await done).toEqual([
      { event: 'log', id: '0', data: line(0) },
      { event: 'log', id: '1', data: line(1) },
      { event: 'status', data: { status: 'done' } },
      { event: 'end', data: { status: 'done' } },
    ]);
  });

  it('stops without an end when the client goes away', async () => {
    const hub = logHubFor<Status>(createEventBus(), 'test');
    const controller = new AbortController();
    const done = collect(
      logStream(
        source(hub, [], () => 'running', true),
        controller.signal,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await done).toEqual([]);
  });
});
