import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_BODY_LIMIT, type Notification, oneLine, sendNtfy } from './ntfy.js';

const target = { url: 'https://ntfy.example.com/launchway', token: 'tk_secret' };
const message: Notification = {
  title: 'Release 1.2.3 deployed',
  priority: 'high',
  tags: ['rocket', 'trail'],
  click: 'https://github.com/o/r/pull/7',
  body: 'PR #7 merged',
};
const respond = (status: number) => new Response(null, { status });
const noSleep = vi.fn(async () => {});

describe('oneLine', () => {
  it('collapses whitespace and newlines to one line', () => {
    expect(oneLine('a\n\n b \t c ')).toBe('a b c');
  });

  it('keeps a body of exactly the limit and cuts a longer one with an ellipsis', () => {
    expect(oneLine('x'.repeat(NOTIFY_BODY_LIMIT))).toHaveLength(NOTIFY_BODY_LIMIT);
    const cut = oneLine('x'.repeat(NOTIFY_BODY_LIMIT + 1));
    expect(Array.from(cut)).toHaveLength(NOTIFY_BODY_LIMIT);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(Array.from(oneLine('😀'.repeat(600)))).toHaveLength(NOTIFY_BODY_LIMIT);
  });
});

describe('sendNtfy', () => {
  it('posts the one-line body with ntfy headers and the bearer token', async () => {
    const send = vi.fn(async () => respond(200));
    const result = await sendNtfy(
      target,
      { ...message, body: `line one\n${'y'.repeat(600)}` },
      { fetch: send as unknown as typeof fetch, sleep: noSleep },
    );
    expect(result).toEqual({ delivered: true, tries: 1 });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({
      title: 'Release 1.2.3 deployed',
      priority: 'high',
      tags: 'rocket,trail',
      click: 'https://github.com/o/r/pull/7',
      authorization: 'Bearer tk_secret',
    });
    expect(String(init.body)).not.toContain('\n');
    expect(Array.from(String(init.body)).length).toBeLessThanOrEqual(NOTIFY_BODY_LIMIT);
  });

  it('omits the authorization header without a token and encodes non-ASCII titles', async () => {
    const send = vi.fn(async () => respond(200));
    await sendNtfy(
      { ...target, token: null },
      { ...message, title: 'Déployé' },
      {
        fetch: send as unknown as typeof fetch,
      },
    );
    const init = (send.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.title).toBe(`=?UTF-8?B?${Buffer.from('Déployé').toString('base64')}?=`);
  });

  it('retries 5xx and network errors with backoff, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const send = vi
      .fn()
      .mockResolvedValueOnce(respond(503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(respond(200));
    const result = await sendNtfy(target, message, {
      fetch: send as unknown as typeof fetch,
      sleep,
      backoffMs: [10, 40],
    });
    expect(result).toEqual({ delivered: true, tries: 3 });
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10, 40]);
  });

  it('gives up after three tries and never throws', async () => {
    const send = vi.fn(async () => respond(500));
    const result = await sendNtfy(target, message, {
      fetch: send as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(result).toEqual({ delivered: false, tries: 3, reason: 'rejected' });
    expect(send).toHaveBeenCalledTimes(3);

    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(
      await sendNtfy(target, message, { fetch: down as unknown as typeof fetch, sleep: noSleep }),
    ).toEqual({ delivered: false, tries: 3, reason: 'unreachable' });
  });

  it('does not retry a rejection that a retry cannot fix (401, 403, 404, a redirect)', async () => {
    for (const status of [401, 403, 404, 302]) {
      const send = vi.fn(async () => respond(status));
      const result = await sendNtfy(target, message, {
        fetch: send as unknown as typeof fetch,
        sleep: noSleep,
      });
      expect(result).toEqual({ delivered: false, tries: 1, reason: 'rejected' });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('never sends a token over http', async () => {
    const send = vi.fn(async () => respond(200));
    const result = await sendNtfy(
      { url: 'http://ntfy.example.com/t', token: 'tk_secret' },
      message,
      {
        fetch: send as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ delivered: false, tries: 0, reason: 'rejected' });
    expect(send).not.toHaveBeenCalled();
  });

  it('retries 429', async () => {
    const send = vi.fn().mockResolvedValueOnce(respond(429)).mockResolvedValueOnce(respond(200));
    const result = await sendNtfy(target, message, {
      fetch: send as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(result).toEqual({ delivered: true, tries: 2 });
  });
});
