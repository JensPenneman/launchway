import { PROBLEM_CONTENT_TYPE } from '@launchway/contracts';
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

  it('declares every tag the operations use, and every operation has an operationId', async () => {
    const res = await app.request('/api/openapi.json');
    const doc = (await res.json()) as {
      tags: { name: string }[];
      paths: Record<string, Record<string, { tags?: string[]; operationId?: string }>>;
    };
    const declared = new Set(doc.tags.map((tag) => tag.name));
    const operations = Object.values(doc.paths).flatMap((ops) => Object.values(ops));
    const used = new Set(operations.flatMap((op) => op.tags ?? []));
    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
    expect(operations.filter((op) => !op.operationId)).toEqual([]);
  });

  it('serves the API reference UI', async () => {
    const res = await app.request('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // An exact version with SRI, never the floating latest bundle.
    expect(await res.text()).toMatch(
      /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/[^"]+" integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous">/,
    );
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
