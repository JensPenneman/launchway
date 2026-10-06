import type { DomainId, DomainStatus, RouteId } from '@slipway/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDeps } from '../../../test/support/deps.js';
import { ProblemError } from '../../lib/problem.js';
import { type CaddyAdmin, CaddyError, type CaddyTransport, createCaddyAdmin } from './caddy.js';
import { createEdgeReconciler } from './reconciler.js';
import type { EdgeRenderInput } from './render.js';

const DOMAIN = 'dom_01jbh8m4x2f8k9z0a1b2c3d4e5' as DomainId;

function input(status: DomainStatus, port = 7878): EdgeRenderInput {
  return {
    settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
    routes: [
      {
        id: 'rt_01jbh8m4x2f8k9z0a1b2c3d4e5' as RouteId,
        domainId: DOMAIN,
        hostname: 'radarr.example.com',
        domain: { status, force: false },
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
