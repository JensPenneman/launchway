import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

describe('GET /events', () => {
  it('requires authentication (401)', async () => {
    expect((await createApp(createTestDeps()).request('/api/v1/events')).status).toBe(401);
  });

  it('streams change events and ends on shutdown', async () => {
    const deps = createTestDeps({ auth: fixedAuth(testPrincipal('viewer')) });
    const res = await createApp(deps).request('/api/v1/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    // The stream subscribes asynchronously; publish until the first event arrives.
    const publisher = setInterval(() => {
      deps.events.publish({ topic: 'users', action: 'updated', resourceId: 'user_x' });
    }, 5);
    const { value } = await reader.read();
    clearInterval(publisher);
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: platform');
    expect(text).toContain('"topic":"users"');

    deps.lifecycle.beginShutdown();
    let done = false;
    while (!done) ({ done } = await reader.read());
    expect(done).toBe(true);
  });
});
