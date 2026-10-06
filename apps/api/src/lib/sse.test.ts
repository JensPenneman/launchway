import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sseResponse } from './sse.js';

describe('sseResponse', () => {
  it('writes each message as an SSE frame with JSON data and ends with the source', async () => {
    const app = new Hono();
    app.get('/stream', (c) =>
      sseResponse(c, async function* () {
        yield { event: 'log', data: { seq: 1, line: 'building' }, id: '1' };
        yield { event: 'end', data: { status: 'running' } };
      }),
    );
    const res = await app.request('/stream');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: log\ndata: {"seq":1,"line":"building"}\nid: 1\n\n');
    expect(body).toContain('event: end\ndata: {"status":"running"}\n\n');
  });

  it('stops when the caller signal is already aborted', async () => {
    const app = new Hono();
    const controller = new AbortController();
    controller.abort();
    let started = false;
    app.get('/stream', (c) =>
      sseResponse(
        c,
        async function* (signal) {
          started = true;
          if (!signal.aborted) yield { event: 'log', data: 'unexpected' };
        },
        { signal: controller.signal },
      ),
    );
    const body = await (await app.request('/stream')).text();
    expect(started).toBe(true);
    expect(body).not.toContain('unexpected');
  });
});
