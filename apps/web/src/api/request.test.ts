import { Settings } from '@slipway/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  buildUrl,
  ContractDriftError,
  errorMessage,
  request,
  setUnauthorizedHandler,
} from './request';

const settings = {
  publicUrl: 'https://deploy.example.com',
  effectivePublicUrl: 'https://deploy.example.com',
  acmeEmail: 'ops@example.com',
  anchorHostname: null,
  dynamicDnsEnabled: false,
  publicIpv4: null,
  publicIpv4CheckedAt: null,
  forwardAuthUrl: null,
  edgeNodeId: null,
  updatedAt: '2026-10-06T12:00:00.000Z',
};

function respond(status: number, body: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': contentType },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('buildUrl', () => {
  it('prefixes the API base and drops empty query values', () => {
    expect(buildUrl('/apps', { limit: 10, cursor: undefined, query: '', follow: true })).toBe(
      '/api/v1/apps?limit=10&follow=true',
    );
  });
});

describe('request', () => {
  it('sends JSON with the session cookie and parses the body with the contract schema', async () => {
    const fetchMock = respond(200, settings);
    const result = await request('/settings', {
      method: 'PATCH',
      body: { acmeEmail: 'ops@example.com' },
      schema: Settings,
    });
    expect(result.publicUrl).toBe('https://deploy.example.com');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/settings');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"acmeEmail":"ops@example.com"}');
  });

  it('turns problem documents into ApiError with field errors', async () => {
    respond(
      400,
      {
        type: 'validation-failed',
        title: 'Validation failed',
        status: 400,
        errors: [{ path: 'body.email', message: 'Invalid email', code: 'invalid_format' }],
      },
      'application/problem+json',
    );
    const error = await request('/setup', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).type).toBe('validation-failed');
    expect((error as ApiError).fieldErrors()).toEqual({ email: 'Invalid email' });
    expect(errorMessage(error)).toBe('Validation failed: Invalid email');
  });

  it('falls back to a generic problem when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await request('/apps').catch((e: unknown) => e);
    expect((error as ApiError).type).toBe('upstream-failed');
  });

  it('calls the unauthorized handler on 401 unless asked to throw', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const problem = { type: 'unauthorized', title: 'Authentication required', status: 401 };
    respond(401, problem);
    await expect(request('/apps')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    respond(401, problem);
    await expect(request('/me', { onUnauthorized: 'throw' })).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports contract drift when the response does not match the schema', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    respond(200, { ...settings, publicUrl: 42 });
    await expect(request('/settings', { schema: Settings })).rejects.toBeInstanceOf(
      ContractDriftError,
    );
  });

  it('maps network failures to a service-unavailable problem', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await request('/apps').catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(503);
  });
});
