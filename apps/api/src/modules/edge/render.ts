import { isIP } from 'node:net';
import {
  type AppId,
  type DomainId,
  type DomainStatus,
  type NodeId,
  type RouteId,
  type RouteTarget,
  type ServiceStatus,
  serviceAlias,
} from '@launchway/contracts';

/** Upstream of the platform's own site on the proxy network. */
export const PLATFORM_UPSTREAM = 'launchway:3000';
/**
 * Default Caddy admin listener: a unix socket on a volume only `caddy` and `launchway` mount, never
 * a TCP port on the shared proxy network. Must be repeated in every config (docs/development.md).
 */
export const CADDY_ADMIN_LISTEN = 'unix//run/caddy-admin/admin.sock|0222';

/**
 * Domain states whose routes are rendered: the DNS preflight passed (`verified`) or Caddy already
 * serves the domain (`active`).
 */
const RENDERABLE_DOMAIN_STATUSES: ReadonlySet<DomainStatus> = new Set(['verified', 'active']);

export interface EdgeSettings {
  /** Effective public URL (LAUNCHWAY_PUBLIC_URL override applied); null renders no platform site. */
  readonly publicUrl: string | null;
  readonly acmeEmail: string | null;
  readonly forwardAuthUrl: string | null;
  readonly edgeNodeId: NodeId | null;
}

export interface EdgeRoute {
  readonly id: RouteId;
  readonly domainId: DomainId;
  readonly hostname: string;
  readonly domain: { readonly status: DomainStatus; readonly force: boolean };
  readonly target: RouteTarget;
  readonly protected: boolean;
  readonly compress: boolean;
  readonly hsts: boolean;
}

export interface EdgeApp {
  readonly id: AppId;
  readonly slug: string;
  readonly nodeId: NodeId;
  /** Services of the app's `running` deployment; null when nothing runs. */
  readonly runningServices: readonly ServiceStatus[] | null;
}

export interface EdgeNode {
  readonly id: NodeId;
  readonly name: string;
  readonly lanIp: string | null;
}

export interface EdgeRenderInput {
  readonly settings: EdgeSettings;
  /** The `admin` listener (`Config.caddyAdminListen`); defaults to the unix socket. */
  readonly adminListen?: string;
  readonly routes: readonly EdgeRoute[];
  readonly apps: readonly EdgeApp[];
  readonly nodes: readonly EdgeNode[];
}

/** True when the route's domain passed the DNS preflight or is forced. */
export function isRenderable(route: Pick<EdgeRoute, 'domain'>): boolean {
  return route.domain.force || RENDERABLE_DOMAIN_STATUSES.has(route.domain.status);
}

/**
 * Makes a value safe as one Caddyfile token: no whitespace, quotes, braces (placeholders) or
 * comment markers survive. Inputs are validated upstream; this is defence in depth.
 */
function token(value: string): string {
  return value.replace(
    /[\s"'`{}#\\]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** `host:port` with IPv6 literals bracketed. */
function hostPort(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Comment text on one line. */
function comment(text: string): string {
  return `# ${text.replace(/[\r\n]+/g, ' ')}`;
}

type Handler = { kind: 'lines'; lines: string[] } | { kind: 'skip'; reason: string };

function siteBlock(address: string, body: readonly string[]): string {
  return [`${token(address)} {`, ...body.map((line) => (line ? `\t${line}` : '')), '}'].join('\n');
}

function options(route: Pick<EdgeRoute, 'protected' | 'compress' | 'hsts'>): string[] {
  const lines: string[] = [];
  if (route.protected) lines.push('import gate');
  if (route.compress) lines.push('encode zstd gzip');
  if (route.hsts) lines.push('header ?Strict-Transport-Security "max-age=31536000"');
  return lines;
}

function redirectTarget(to: string): string {
  const url = new URL(to);
  const href = token(url.href);
  // Keep the request path when the target has no query or fragment of its own.
  if (url.search || url.hash) return href;
  return `${href.replace(/\/+$/, '')}{uri}`;
}

function handler(
  route: EdgeRoute,
  input: EdgeRenderInput,
  apps: Map<AppId, EdgeApp>,
  nodes: Map<NodeId, EdgeNode>,
): Handler {
  const target = route.target;
  switch (target.kind) {
    case 'redirect':
      return {
        kind: 'lines',
        lines: [`redir ${redirectTarget(target.to)} ${target.permanent ? '308' : '307'}`],
      };
    case 'external': {
      const host = token(target.host);
      const upstream = `${target.scheme}://${hostPort(host, target.port)}`;
      if (target.scheme === 'http') return { kind: 'lines', lines: [`reverse_proxy ${upstream}`] };
      return {
        kind: 'lines',
        lines: [
          `reverse_proxy ${upstream} {`,
          '\ttransport http {',
          `\t\ttls_server_name ${host}`,
          '\t}',
          '}',
        ],
      };
    }
    case 'app': {
      const app = apps.get(target.appId);
      if (!app) return { kind: 'skip', reason: 'the app does not exist' };
      const edgeNodeId = input.settings.edgeNodeId;
      if (edgeNodeId === null || app.nodeId === edgeNodeId) {
        let alias: string;
        try {
          alias = serviceAlias(app.slug, target.service);
        } catch {
          return { kind: 'skip', reason: 'the service alias is too long' };
        }
        return { kind: 'lines', lines: [`reverse_proxy ${token(alias)}:${target.port}`] };
      }
      const node = nodes.get(app.nodeId);
      if (!node?.lanIp) {
        return { kind: 'skip', reason: `node ${node?.name ?? app.nodeId} has no LAN address` };
      }
      if (!app.runningServices) {
        return { kind: 'skip', reason: `app ${app.slug} has no running deployment` };
      }
      const service = app.runningServices.find((s) => s.service === target.service);
      const published = service?.publishedPorts
        .filter((p) => p.containerPort === target.port && p.protocol === 'tcp')
        .sort((a, b) => a.hostPort - b.hostPort)[0];
      if (!published) {
        return {
          kind: 'skip',
          reason: `service ${target.service} of app ${app.slug} publishes no port for ${target.port}`,
        };
      }
      return {
        kind: 'lines',
        lines: [`reverse_proxy ${hostPort(token(node.lanIp), published.hostPort)}`],
      };
    }
  }
}

function forwardAuth(url: string): string[] {
  const parsed = new URL(url);
  const upstream = token(`${parsed.protocol}//${parsed.host}`);
  const uri = token(`${parsed.pathname}${parsed.search}`);
  return [
    '(gate) {',
    `\tforward_auth ${upstream} {`,
    `\t\turi ${uri}`,
    '\t\tcopy_headers X-Auth-Request-User X-Auth-Request-Email X-Auth-Request-Groups',
    '\t}',
    '}',
  ];
}

/** Site address of the platform URL: `host[:port]`, prefixed with `http://` for plain HTTP. */
function platformAddress(publicUrl: string): { address: string; host: string; https: boolean } {
  const url = new URL(publicUrl);
  const https = url.protocol === 'https:';
  return { address: https ? url.host : `http://${url.host}`, host: url.hostname, https };
}

export interface RenderedEdge {
  readonly caddyfile: string;
  /** Routes that got a site block, in output order. */
  readonly rendered: readonly EdgeRoute[];
}

/**
 * Renders the complete Caddyfile (spec section 5). Pure and deterministic: the same input
 * always yields the same text, so unchanged configurations are not reloaded.
 */
export function renderEdge(input: EdgeRenderInput): RenderedEdge {
  const { settings } = input;
  const apps = new Map(input.apps.map((app) => [app.id, app]));
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const gate = settings.forwardAuthUrl !== null;
  const blocks: string[] = [];

  const global = ['{', `\tadmin ${token(input.adminListen ?? CADDY_ADMIN_LISTEN)}`];
  if (settings.acmeEmail) global.push(`\temail ${token(settings.acmeEmail)}`);
  global.push('\tcert_issuer acme', '}');
  blocks.push(
    [
      '# Generated by Launchway from its routes. Changes made here are overwritten.',
      ...global,
    ].join('\n'),
  );

  if (settings.forwardAuthUrl) blocks.push(forwardAuth(settings.forwardAuthUrl).join('\n'));

  const platform = settings.publicUrl ? platformAddress(settings.publicUrl) : null;
  if (platform) {
    blocks.push(
      [
        comment('Launchway'),
        siteBlock(platform.address, [
          ...options({ protected: false, compress: true, hsts: platform.https }),
          `reverse_proxy ${PLATFORM_UPSTREAM}`,
        ]),
      ].join('\n'),
    );
  }

  const routes = [...input.routes].sort((a, b) =>
    a.hostname === b.hostname ? a.id.localeCompare(b.id) : a.hostname.localeCompare(b.hostname),
  );
  const seen = new Set<string>(platform ? [platform.host] : []);
  const rendered: EdgeRoute[] = [];
  for (const route of routes) {
    const label = comment(`route ${route.id} (${route.target.kind})`);
    if (!isRenderable(route)) {
      blocks.push(
        comment(`${route.hostname}: skipped, DNS preflight not passed (${route.domain.status})`),
      );
      continue;
    }
    if (seen.has(route.hostname)) {
      blocks.push(comment(`${route.hostname}: skipped, the host name is already served`));
      continue;
    }
    if (route.protected && !gate) {
      // Fail closed: never serve a protected route without its gate.
      blocks.push(comment(`${route.hostname}: skipped, protected but no forward-auth URL is set`));
      continue;
    }
    const result = handler(route, input, apps, nodes);
    if (result.kind === 'skip') {
      blocks.push(comment(`${route.hostname}: skipped, ${result.reason}`));
      continue;
    }
    seen.add(route.hostname);
    rendered.push(route);
    blocks.push(
      [label, siteBlock(route.hostname, [...options(route), ...result.lines])].join('\n'),
    );
  }

  return { caddyfile: `${blocks.join('\n\n')}\n`, rendered };
}
