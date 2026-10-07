import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DomainId, DomainStatus, RouteId } from '@launchway/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDeps } from '../../../test/support/deps.js';
import { ProblemError } from '../../lib/problem.js';
import { type CaddyAdmin, CaddyError, type CaddyTransport, createCaddyAdmin } from './caddy.js';
import { createEdgeReconciler } from './reconciler.js';
import type { EdgeRenderInput } from './render.js';

const DOMAIN = 'dom_01jbh8m4x2f8k9z0a1b2c3d4e5' as DomainId;

function input(status: DomainStatus, port = 7878, force = false): EdgeRenderInput {
  return {
    settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
    routes: [
      {
        id: 'rt_01jbh8m4x2f8k9z0a1b2c3d4e5' as RouteId,
        domainId: DOMAIN,
        hostname: 'radarr.example.com',
        domain: { status, force },
        target: { kind: 'external', scheme: 'http', host: 'host.docker.internal', port },
        protected: false,
        compress: true,
        hsts: true,
      },
    ],
    apps: [],
    nodes: [],
  };
}

function fakeCaddy(): CaddyAdmin & { loaded: string[]; fail: CaddyError | null } {
  const caddy = {
    loaded: [] as string[],
    fail: null as CaddyError | null,
    adapt: () => Promise.resolve({}),
    load(caddyfile: string) {
      if (caddy.fail) return Promise.reject(caddy.fail);
      caddy.loaded.push(caddyfile);
      return Promise.resolve();
    },
  };
  return caddy;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('edge reconciler', () => {
  it('loads, skips unchanged configurations and marks verified domains active', async () => {
    const caddy = fakeCaddy();
    let current = input('verified');
    const markDomainActive = vi.fn(() => Promise.resolve());
    const reconciler = createEdgeReconciler(createTestDeps(), {
      caddy,
      loadInput: () => Promise.resolve(current),
    });
    reconciler.start({ markDomainActive });

    const first = await reconciler.apply();
    expect(caddy.loaded).toHaveLength(1);
    expect(first).toMatchObject({ inSync: true, lastError: null });
    expect(first.appliedCaddyfile).toBe(first.caddyfile);
    expect(markDomainActive).toHaveBeenCalledWith(DOMAIN);

    await reconciler.apply();
    expect(caddy.loaded).toHaveLength(1);
    await reconciler.apply({ force: true });
    expect(caddy.loaded).toHaveLength(2);

    current = input('active', 9000);
    markDomainActive.mockClear();
    await reconciler.apply();
    expect(caddy.loaded).toHaveLength(3);
    expect(caddy.loaded[2]).toContain('host.docker.internal:9000');
    expect(markDomainActive).not.toHaveBeenCalled();
  });

  it('activates a forced domain that passes its DNS check later, without reloading', async () => {
    const caddy = fakeCaddy();
    let current = input('pending', 7878, true);
    const markDomainActive = vi.fn(() => Promise.resolve());
    const reconciler = createEdgeReconciler(createTestDeps(), {
      caddy,
      loadInput: () => Promise.resolve(current),
    });
    reconciler.start({ markDomainActive });

    await reconciler.apply();
    expect(caddy.loaded).toHaveLength(1);
    expect(markDomainActive).not.toHaveBeenCalled();

    current = input('verified', 7878, true);
    await reconciler.apply();
    expect(caddy.loaded).toHaveLength(1);
    expect(markDomainActive).toHaveBeenCalledWith(DOMAIN);
  });

  it('remembers the last error and reports it as a problem with Caddy’s message', async () => {
    const caddy = fakeCaddy();
    const reconciler = createEdgeReconciler(createTestDeps(), {
      caddy,
      loadInput: () => Promise.resolve(input('verified')),
    });
    caddy.fail = new CaddyError('adapting config using caddyfile: unknown directive: nope', false);
    const error = await reconciler.apply().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ type: 'upstream-failed', status: 502 });
    expect((error as ProblemError).detail).toContain('unknown directive: nope');

    const config = await reconciler.config();
    expect(config).toMatchObject({ inSync: false, loadedAt: null, appliedCaddyfile: null });
    expect(config.lastError?.message).toContain('unknown directive');

    caddy.fail = null;
    expect(await reconciler.apply()).toMatchObject({ inSync: true, lastError: null });
  });

  it('debounces change events of the relevant topics', async () => {
    vi.useFakeTimers();
    const caddy = fakeCaddy();
    const deps = createTestDeps();
    let renders = 0;
    const reconciler = createEdgeReconciler(deps, {
      caddy,
      debounceMs: 500,
      loadInput: () => {
        renders += 1;
        return Promise.resolve(input('verified', 7000 + renders));
      },
    });
    reconciler.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(renders).toBe(1);

    for (let i = 0; i < 5; i++) {
      deps.events.publish({ topic: 'routes', action: 'updated', resourceId: null });
      await vi.advanceTimersByTimeAsync(100);
    }
    deps.events.publish({ topic: 'users', action: 'updated', resourceId: null });
    expect(renders).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(renders).toBe(2);
    expect(caddy.loaded).toHaveLength(2);

    deps.lifecycle.beginShutdown();
    deps.events.publish({ topic: 'routes', action: 'updated', resourceId: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(2);
  });

  it('re-renders when a deployment starts or stops running, or is removed', async () => {
    vi.useFakeTimers();
    const deps = createTestDeps();
    let renders = 0;
    const reconciler = createEdgeReconciler(deps, {
      caddy: fakeCaddy(),
      debounceMs: 10,
      loadInput: () => {
        renders += 1;
        return Promise.resolve(input('verified'));
      },
    });
    reconciler.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(renders).toBe(1);

    const changes = [
      ...(['running', 'stopped', 'failed', 'superseded'] as const).map((status) => ({
        topic: 'deployments' as const,
        action: 'updated' as const,
        data: { status },
      })),
      { topic: 'deployments' as const, action: 'deleted' as const },
      // Removing a preview removes its deployments.
      { topic: 'previews' as const, action: 'deleted' as const },
      { topic: 'apps' as const, action: 'deleted' as const },
    ];
    for (const change of changes) {
      deps.events.publish({ ...change, resourceId: null });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(renders).toBe(1 + changes.length);
    deps.lifecycle.beginShutdown();
  });
});

describe('edge reconciler retries', () => {
  it('retries a failed scheduled load with backoff and announces the load state', async () => {
    vi.useFakeTimers();
    const caddy = fakeCaddy();
    caddy.fail = new CaddyError('connect ECONNREFUSED', true);
    const deps = createTestDeps();
    const edgeEvents: string[] = [];
    deps.events.subscribe((event) => {
      if (event.topic === 'edge') edgeEvents.push(event.action);
    });
    const reconciler = createEdgeReconciler(deps, {
      caddy,
      debounceMs: 10,
      loadInput: () => Promise.resolve(input('verified')),
    });
    reconciler.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(caddy.loaded).toHaveLength(0);
    expect(edgeEvents).toHaveLength(1);

    // Caddy is back (e.g. after an upgrade): the retry loads without any other change.
    caddy.fail = null;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(caddy.loaded).toHaveLength(1);
    expect((await reconciler.config()).lastError).toBeNull();
    expect(edgeEvents).toHaveLength(2);
    deps.lifecycle.beginShutdown();
  });
});

describe('caddy admin client', () => {
  it('adapts, then loads the adapted JSON', async () => {
    const calls: { url: string; type: string; body: string }[] = [];
    const transport: CaddyTransport = (url, body, type) => {
      calls.push({ url, type, body });
      return Promise.resolve(
        url.endsWith('/adapt')
          ? { status: 200, body: JSON.stringify({ result: { apps: {} } }) }
          : { status: 200, body: '' },
      );
    };
    await createCaddyAdmin('http://caddy:2019/', transport).load(':80 {\n}\n');
    expect(calls).toEqual([
      { url: 'http://caddy:2019/adapt', type: 'text/caddyfile', body: ':80 {\n}\n' },
      { url: 'http://caddy:2019/load', type: 'application/json', body: '{"apps":{}}' },
    ]);
  });

  it('reaches a unix-socket admin API with a Host header Caddy accepts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'caddy-admin-'));
    const socket = join(dir, 'admin.sock');
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.host}`);
      response.end(request.url === '/adapt' ? JSON.stringify({ result: {} }) : '');
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await createCaddyAdmin(`unix://${socket}`).load(':80 {\n}\n');
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual(['POST /adapt 127.0.0.1', 'POST /load 127.0.0.1']);
  });

  it('maps Caddy errors and unreachable admin APIs to problems', async () => {
    const rejecting: CaddyTransport = () =>
      Promise.resolve({
        status: 400,
        body: JSON.stringify({ error: 'loading config: bad thing' }),
      });
    const error = await createCaddyAdmin('http://caddy:2019', rejecting)
      .load('x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CaddyError);
    expect((error as CaddyError).message).toBe('loading config: bad thing');
    expect((error as CaddyError).toProblem()).toMatchObject({ type: 'upstream-failed' });

    const down: CaddyTransport = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const unreachable = await createCaddyAdmin('http://caddy:2019', down)
      .load('x')
      .then(
        () => null,
        (e: unknown) => e as CaddyError,
      );
    if (!unreachable) throw new Error('expected a failure');
    expect(unreachable.unreachable).toBe(true);
    expect(unreachable.toProblem()).toMatchObject({ type: 'service-unavailable', status: 503 });
  });
});
