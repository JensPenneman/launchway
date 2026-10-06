import type { AppId, DomainId, NodeId, RouteId, ServiceStatus } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { type EdgeRenderInput, type EdgeRoute, renderEdge } from './render.js';

// Fixed ids keep the golden files stable.
const EDGE = 'node_01jbh8m4x2f8k9z0a1b2c3d4e5' as NodeId;
const REMOTE = 'node_01jbh8m4x2f8k9z0a1b2c3d4e6' as NodeId;
const TRAIL = 'app_01jbh8m4x2f8k9z0a1b2c3d4e7' as AppId;
const SHOP = 'app_01jbh8m4x2f8k9z0a1b2c3d4e8' as AppId;
const IDLE = 'app_01jbh8m4x2f8k9z0a1b2c3d4e9' as AppId;

let sequence = 0;
function route(hostname: string, overrides: Partial<EdgeRoute> = {}): EdgeRoute {
  sequence += 1;
  const suffix = String(sequence).padStart(2, '0');
  return {
    id: `rt_01jbh8m4x2f8k9z0a1b2c3d4${suffix}` as RouteId,
    domainId: `dom_01jbh8m4x2f8k9z0a1b2c3d4${suffix}` as DomainId,
    hostname,
    domain: { status: 'verified', force: false },
    target: { kind: 'external', scheme: 'http', host: 'host.docker.internal', port: 7878 },
    protected: false,
    compress: true,
    hsts: true,
    ...overrides,
  };
}

const shopServices: ServiceStatus[] = [
  {
    service: 'web',
    containerId: 'c1',
    state: 'running',
    health: 'healthy',
    publishedPorts: [
      { containerPort: 3000, hostPort: 18080, protocol: 'tcp', hostIp: '192.168.1.30' },
      { containerPort: 3000, hostPort: 18081, protocol: 'udp', hostIp: null },
    ],
  },
];

function fullInput(): EdgeRenderInput {
  sequence = 0;
  return {
    settings: {
      publicUrl: 'https://deploy.example.com',
      acmeEmail: 'ops@example.com',
      forwardAuthUrl: 'http://gate-proxy:4180/oauth2/auth',
      edgeNodeId: EDGE,
    },
    // Deliberately unsorted: the output is ordered by host name.
    routes: [
      route('trail.example.com', {
        target: { kind: 'app', appId: TRAIL, service: 'web', port: 8080 },
        protected: true,
      }),
      route('shop.example.com', {
        target: { kind: 'app', appId: SHOP, service: 'web', port: 3000 },
        hsts: false,
      }),
      route('idle.example.com', {
        target: { kind: 'app', appId: IDLE, service: 'web', port: 80 },
      }),
      route('radarr.example.com', { compress: false }),
      route('nas.example.com', {
        target: { kind: 'external', scheme: 'https', host: 'nas.lan', port: 5001 },
      }),
      route('v6.example.com', {
        target: { kind: 'external', scheme: 'http', host: 'fd00::10', port: 8000 },
        compress: false,
        hsts: false,
      }),
      route('old.example.com', {
        target: { kind: 'redirect', to: 'https://new.example.com/', permanent: true },
      }),
      route('docs.example.com', {
        target: { kind: 'redirect', to: 'https://example.com/docs?from=old', permanent: false },
      }),
      route('pending.example.com', { domain: { status: 'pending', force: false } }),
      route('forced.example.com', { domain: { status: 'misconfigured', force: true } }),
      route('deploy.example.com'),
    ],
    apps: [
      { id: TRAIL, slug: 'trail', nodeId: EDGE, runningServices: null },
      { id: SHOP, slug: 'shop', nodeId: REMOTE, runningServices: shopServices },
      { id: IDLE, slug: 'idle', nodeId: REMOTE, runningServices: null },
    ],
    nodes: [
      { id: EDGE, name: 'local', lanIp: '192.168.1.10' },
      { id: REMOTE, name: 'nuc', lanIp: '192.168.1.30' },
    ],
  };
}

describe('renderEdge (golden files)', () => {
  it('renders every target kind, option and skip reason', async () => {
    const { caddyfile, rendered } = renderEdge(fullInput());
    await expect(caddyfile).toMatchFileSnapshot('./__golden__/full.caddyfile');
    expect(rendered.map((r) => r.hostname)).toEqual([
      'docs.example.com',
      'forced.example.com',
      'nas.example.com',
      'old.example.com',
      'radarr.example.com',
      'shop.example.com',
      'trail.example.com',
      'v6.example.com',
    ]);
  });

  it('renders only the global block for an empty installation', async () => {
    const { caddyfile } = renderEdge({
      settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
      routes: [],
      apps: [],
      nodes: [],
    });
    await expect(caddyfile).toMatchFileSnapshot('./__golden__/empty.caddyfile');
  });

  it('is deterministic regardless of input order', () => {
    const input = fullInput();
    const reversed = {
      ...input,
      routes: [...input.routes].reverse(),
      apps: [...input.apps].reverse(),
    };
    expect(renderEdge(reversed).caddyfile).toBe(renderEdge(input).caddyfile);
  });

  it('fails closed: protected routes are skipped while no forward-auth URL is set', () => {
    sequence = 0;
    const { caddyfile, rendered } = renderEdge({
      settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
      routes: [route('secret.example.com', { protected: true })],
      apps: [],
      nodes: [],
    });
    expect(rendered).toEqual([]);
    expect(caddyfile).toContain('# secret.example.com: skipped, protected but no forward-auth URL');
    expect(caddyfile).not.toContain('secret.example.com {');
  });

  it('serves apps by alias when no edge node is configured (single-node installs)', () => {
    sequence = 0;
    const { caddyfile } = renderEdge({
      settings: {
        publicUrl: 'http://10.0.0.5:8080',
        acmeEmail: null,
        forwardAuthUrl: null,
        edgeNodeId: null,
      },
      routes: [
        route('a.example.com', {
          target: { kind: 'app', appId: SHOP, service: 'api', port: 9000 },
        }),
      ],
      apps: [{ id: SHOP, slug: 'shop', nodeId: REMOTE, runningServices: null }],
      nodes: [],
    });
    expect(caddyfile).toContain('reverse_proxy shop-api:9000');
    expect(caddyfile).toContain('http://10.0.0.5:8080 {');
    expect(caddyfile).not.toContain(
      'Strict-Transport-Security "max-age=31536000"\n\treverse_proxy slipway',
    );
  });

  it('neutralizes Caddy placeholders and whitespace in user-supplied URLs', () => {
    sequence = 0;
    const { caddyfile } = renderEdge({
      settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
      routes: [
        route('x.example.com', {
          target: {
            kind: 'redirect',
            to: 'https://example.com/?q={env.SLIPWAY_SECRET_KEY}',
            permanent: false,
          },
        }),
      ],
      apps: [],
      nodes: [],
    });
    expect(caddyfile).not.toContain('{env.');
    expect(caddyfile).toContain('redir https://example.com/?q=%7Benv.SLIPWAY_SECRET_KEY%7D 307');
  });
});
