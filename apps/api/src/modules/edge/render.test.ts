import type { AppId, DomainId, NodeId, RouteId, ServiceStatus } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  type EdgeRenderInput,
  type EdgeRoute,
  extraDirectiveLines,
  renderDirectivesProbe,
  renderEdge,
} from './render.js';

// Fixed ids keep the golden files stable.
const EDGE = 'node_01jbh8m4x2f8k9z0a1b2c3d4e5' as NodeId;
const REMOTE = 'node_01jbh8m4x2f8k9z0a1b2c3d4e6' as NodeId;
const TRAIL = 'app_01jbh8m4x2f8k9z0a1b2c3d4e7' as AppId;
const SHOP = 'app_01jbh8m4x2f8k9z0a1b2c3d4e8' as AppId;
const IDLE = 'app_01jbh8m4x2f8k9z0a1b2c3d4e9' as AppId;
const LOGIN = 'app_01jbh8m4x2f8k9z0a1b2c3d4ea' as AppId;

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

  it('keeps the admin API on the unix socket, never on a TCP address', () => {
    const { caddyfile } = renderEdge(fullInput());
    const admin = caddyfile.split('\n').find((line) => line.trim().startsWith('admin '));
    expect(admin?.trim()).toBe('admin unix//run/caddy-admin/admin.sock|0222');
    expect(caddyfile).not.toMatch(/admin\s+[^\s]*:\d+/);
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
      'Strict-Transport-Security "max-age=31536000"\n\treverse_proxy launchway',
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
            to: 'https://example.com/?q={env.LAUNCHWAY_SECRET_KEY}',
            permanent: false,
          },
        }),
      ],
      apps: [],
      nodes: [],
    });
    expect(caddyfile).not.toContain('{env.');
    expect(caddyfile).toContain('redir https://example.com/?q=%7Benv.LAUNCHWAY_SECRET_KEY%7D 307');
  });

  it('renders the extra directives verbatim after the options and before the upstream', () => {
    sequence = 0;
    const { caddyfile } = renderEdge({
      settings: { publicUrl: null, acmeEmail: null, forwardAuthUrl: null, edgeNodeId: null },
      routes: [
        route('x.example.com', {
          extraDirectives: '\r\nrequest_header -X-API-KEY  \r\n\r\n@closed path /setup*\n',
          target: { kind: 'redirect', to: 'https://example.com', permanent: true },
        }),
      ],
      apps: [],
      nodes: [],
    });
    expect(caddyfile).toContain(
      [
        'x.example.com {',
        '\tencode zstd gzip',
        '\theader ?Strict-Transport-Security "max-age=31536000"',
        '\trequest_header -X-API-KEY',
        '',
        '\t@closed path /setup*',
        '\tredir https://example.com{uri} 308',
        '}',
      ].join('\n'),
    );
  });
});

/** The passkey gate as a Launchway app: Pocket ID routed, oauth2-proxy attached without a route. */
function gateInput(overrides: Partial<EdgeRenderInput['settings']> = {}): EdgeRenderInput {
  sequence = 0;
  return {
    settings: {
      publicUrl: null,
      acmeEmail: 'ops@example.com',
      forwardAuthUrl: null,
      forwardAuthTarget: { appId: LOGIN, service: 'oauth2-proxy', port: 4180, uri: '/oauth2/auth' },
      edgeNodeId: EDGE,
      ...overrides,
    },
    routes: [
      route('login.example.com', {
        target: { kind: 'app', appId: LOGIN, service: 'pocket-id', port: 1411 },
        extraDirectives: [
          'handle /oauth2/* {',
          '\treverse_proxy login-oauth2-proxy:4180',
          '}',
          '@closed path /setup* /signup* /api/signup*',
          'respond @closed 404',
          'request_header -X-API-KEY',
        ].join('\n'),
      }),
      route('trail.example.com', {
        target: { kind: 'app', appId: TRAIL, service: 'web', port: 8080 },
        protected: true,
      }),
    ],
    apps: [
      { id: LOGIN, slug: 'login', nodeId: EDGE, runningServices: null },
      { id: TRAIL, slug: 'trail', nodeId: EDGE, runningServices: null },
    ],
    nodes: [{ id: EDGE, name: 'local', lanIp: '192.168.1.10' }],
  };
}

describe('renderEdge (forward-auth app target)', () => {
  it('reaches the gate by alias and never renders the attach-only service as a site', async () => {
    const { caddyfile, rendered } = renderEdge(gateInput());
    await expect(caddyfile).toMatchFileSnapshot('./__golden__/gate-target.caddyfile');
    expect(caddyfile).toContain('forward_auth http://login-oauth2-proxy:4180 {');
    expect(caddyfile).toContain('\t\turi /oauth2/auth');
    expect(rendered.map((r) => r.hostname)).toEqual(['login.example.com', 'trail.example.com']);
    expect(caddyfile).not.toMatch(/^login-oauth2-proxy/m);
  });

  it('fails closed when the gate app does not run on the edge node', () => {
    const input = gateInput();
    const { caddyfile, rendered } = renderEdge({
      ...input,
      apps: input.apps.map((app) => (app.id === LOGIN ? { ...app, nodeId: REMOTE } : app)),
    });
    expect(caddyfile).toContain(
      '# forward auth: unavailable, the forward-auth app login does not run on the edge node',
    );
    expect(caddyfile).not.toContain('(gate)');
    expect(caddyfile).toContain(
      '# trail.example.com: skipped, protected but the forward-auth gate is unavailable',
    );
    expect(rendered.map((r) => r.hostname)).not.toContain('trail.example.com');
  });

  it('fails closed when the gate app is gone', () => {
    const input = gateInput();
    const { caddyfile } = renderEdge({
      ...input,
      apps: input.apps.filter((app) => app.id !== LOGIN),
    });
    expect(caddyfile).toContain('# forward auth: unavailable, the forward-auth app does not exist');
    expect(caddyfile).not.toContain('trail.example.com {');
  });
});

describe('extra directive helpers', () => {
  it('normalizes line endings and drops surrounding blank lines', () => {
    expect(extraDirectiveLines('\n\nencode gzip\r\n\theader X 1  \n\n')).toEqual([
      'encode gzip',
      '\theader X 1',
    ]);
    expect(extraDirectiveLines(null)).toEqual([]);
  });

  it('renders a probe with just one site and reports where the directives start', () => {
    const probe = renderDirectivesProbe(
      { hostname: 'login.example.com', protected: true, compress: false, hsts: false },
      'respond /x 404\nrequest_header -X-API-KEY',
    );
    const lines = probe.caddyfile.split('\n');
    expect(lines[probe.firstLine - 1]).toBe('\trespond /x 404');
    expect(lines[probe.firstLine]).toBe('\trequest_header -X-API-KEY');
    expect(probe.lineCount).toBe(2);
    expect(probe.caddyfile).toContain('\timport gate');
    expect(probe.caddyfile.match(/^\S.* \{$/gm)).toEqual(['(gate) {', 'login.example.com {']);
  });
});
