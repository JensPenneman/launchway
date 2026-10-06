import { PROBLEM_CONTENT_TYPE } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps } from '../test/support/deps.js';
import { createApp } from './app.js';

const app = createApp(createTestDeps());

describe('app', () => {
  it('answers liveness without touching the database', async () => {
    const res = await app.request('/api/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.0-test' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reports not ready when the database is unreachable', async () => {
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
  });

  it('serves an OpenAPI 3.1 document with the settings routes and security schemes', async () => {
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths['/api/v1/settings'] ?? {})).toEqual(
      expect.arrayContaining(['get', 'patch']),
    );
    expect(doc.paths['/api/health/ready']).toBeDefined();
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(doc.components.schemas).toHaveProperty('Problem');
  });

  it('serves the API reference UI', async () => {
    const res = await app.request('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('answers unknown API routes with a problem document', async () => {
    const res = await app.request('/api/v1/nope', { headers: { 'x-request-id': 'req-123' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toMatchObject({
      type: 'not-found',
      status: 404,
      instance: '/api/v1/nope',
      requestId: 'req-123',
    });
  });
});
