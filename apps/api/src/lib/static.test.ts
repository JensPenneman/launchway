import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../../test/support/deps.js';
import { createApp } from '../app.js';

describe('web UI', () => {
  let root: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'slipway-web-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Slipway</title>');
    writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("ui");');
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const deps = createTestDeps();
    app = createApp({ ...deps, config: { ...deps.config, webRoot: root } });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serves hashed assets with a long cache lifetime', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log("ui");');
  });

  it('answers a missing asset with 404 instead of the index page', async () => {
    const res = await app.request('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('serves other files and falls back to index.html for client routes', async () => {
    expect((await app.request('/favicon.svg')).status).toBe(200);
    const res = await app.request('/apps/app_123?tab=deployments');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>Slipway</title>');
  });

  it('keeps unknown API paths as problem documents', async () => {
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
});
