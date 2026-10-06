import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhooks.js';

const body = Buffer.from('{"zen":"Keep it logically awesome."}');
const sign = (secret: string, payload: Uint8Array) =>
  `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  it('accepts the HMAC of the raw body', () => {
    expect(verifyWebhookSignature('s3cret', body, sign('s3cret', body))).toBe(true);
    expect(
      verifyWebhookSignature(
        's3cret',
        body,
        sign('s3cret', body).toUpperCase().replace('SHA256=', 'sha256='),
      ),
    ).toBe(true);
  });

  it('rejects other secrets, modified bodies and malformed headers', () => {
    expect(verifyWebhookSignature('other', body, sign('s3cret', body))).toBe(false);
    expect(verifyWebhookSignature('s3cret', Buffer.from(`${body} `), sign('s3cret', body))).toBe(
      false,
    );
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha256=abc')).toBe(false);
  });
});
