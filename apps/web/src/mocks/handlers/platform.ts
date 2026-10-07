import {
  type AppManifestStart,
  CreateNodeInput,
  CreatePatConnectionInput,
  type GitHubConnection,
  generateId,
  type Node,
  type NodeJoinToken,
  StartAppManifestInput,
  UpdateNodeInput,
  UpdateSettingsInput,
} from '@launchway/contracts';
import { HttpResponse, http, sse } from 'msw';
import { db } from '../db';
import { createReleases, createRepos } from '../fixtures';
import { API, guard, now, paginate, parseBody, problem, randomToken, recordAudit } from '../util';

function joinToken(): NodeJoinToken {
  const token = randomToken('lwyn_');
  const serverUrl = (db.settings.effectivePublicUrl ?? location.origin).replace(/^http/, 'ws');
  return {
    token,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    serverUrl,
    dockerRunCommand: [
      'docker run -d --name launchway-agent --restart unless-stopped \\',
      '  -v /var/run/docker.sock:/var/run/docker.sock \\',
      '  -v launchway-agent:/var/lib/launchway \\',
      `  -e LAUNCHWAY_SERVER_URL=${serverUrl} \\`,
      `  -e LAUNCHWAY_JOIN_TOKEN=${token} \\`,
      '  ghcr.io/jenspenneman/launchway-agent:latest',
    ].join('\n'),
    composeSnippet: [
      'services:',
      '  launchway-agent:',
      '    image: ghcr.io/jenspenneman/launchway-agent:latest',
      '    restart: unless-stopped',
      '    init: true',
      '    environment:',
      `      LAUNCHWAY_SERVER_URL: ${serverUrl}`,
      `      LAUNCHWAY_JOIN_TOKEN: ${token}`,
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock',
      '      - launchway-agent:/var/lib/launchway',
      'volumes:',
      '  launchway-agent: {}',
    ].join('\n'),
  };
}

/** Caddyfile as the API would render it from settings and routes. */
export function renderCaddyfile(): string {
  const blocks: string[] = [
    `{\n\temail ${db.settings.acmeEmail ?? 'unset'}\n\tcert_issuer acme\n}`,
  ];
  if (db.settings.forwardAuthUrl) {
    blocks.push(
      `(gate) {\n\tforward_auth ${db.settings.forwardAuthUrl} {\n\t\turi /\n\t\tcopy_headers X-Forwarded-User X-Forwarded-Email\n\t}\n}`,
    );
  }
  if (db.settings.publicUrl) {
    blocks.push(
      `${new URL(db.settings.publicUrl).host} {\n\tencode zstd gzip\n\treverse_proxy launchway:3000\n}`,
    );
  }
  for (const route of db.routes) {
    const domain = db.domains.find((item) => item.id === route.domainId);
    if (domain && domain.status !== 'verified' && !domain.force) continue;
    const lines: string[] = [];
    if (route.protected) lines.push('import gate');
    if (route.compress) lines.push('encode zstd gzip');
    if (route.hsts) lines.push('header ?Strict-Transport-Security "max-age=31536000"');
    const target = route.target;
    if (target.kind === 'app') {
      const app = db.apps.find((item) => item.id === target.appId);
      lines.push(`reverse_proxy ${app?.slug ?? 'app'}-${target.service}:${target.port}`);
    } else if (target.kind === 'external') {
      lines.push(`reverse_proxy ${target.scheme}://${target.host}:${target.port}`);
    } else {
      lines.push(`redir ${target.to} ${target.permanent ? 'permanent' : 'temporary'}`);
    }
    blocks.push(`${route.hostname} {\n${lines.map((line) => `\t${line}`).join('\n')}\n}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

function edgeStatus() {
  const caddyfile = renderCaddyfile();
  db.edgeAppliedCaddyfile ??= caddyfile;
  return {
    caddyfile,
    renderedAt: now(),
    loadedAt: db.edgeLoadedAt,
    appliedCaddyfile: db.edgeAppliedCaddyfile,
    inSync: db.edgeAppliedCaddyfile === caddyfile,
    lastError: null,
  };
}

export const platformHandlers = [
  // --- Change feed -------------------------------------------------------------------------------
  sse<{ platform: string }>(`${API}/events`, ({ client, request }) => {
    if (!db.role()) {
      client.error();
      return;
    }
    const unsubscribe = db.onPlatformEvent((event) =>
      client.send({ id: event.id, event: 'platform', data: JSON.stringify(event) }),
    );
    request.signal.addEventListener('abort', unsubscribe);
  }),

  // --- Settings and edge -------------------------------------------------------------------------
  http.get(`${API}/settings`, () => guard('viewer') ?? HttpResponse.json(db.settings)),
  http.patch(`${API}/settings`, async ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, UpdateSettingsInput);
    if (error) return error;
    Object.assign(db.settings, data, { updatedAt: now() });
    if (data.publicUrl !== undefined) db.settings.effectivePublicUrl = data.publicUrl;
    if (data.edgeNodeId !== undefined) {
      for (const node of db.nodes) node.isEdge = node.id === data.edgeNodeId;
      db.emit('nodes', 'updated', data.edgeNodeId);
    }
    recordAudit('settings.update', 'settings', null, { fields: Object.keys(data) });
    db.emit('settings', 'updated', null);
    return HttpResponse.json(db.settings);
  }),
  http.get(`${API}/edge/config`, () => guard('admin') ?? HttpResponse.json(edgeStatus())),
  http.post(`${API}/edge/reload`, () => {
    const denied = guard('admin');
    if (denied) return denied;
    db.edgeLoadedAt = now();
    db.edgeAppliedCaddyfile = renderCaddyfile();
    recordAudit('edge.reload', 'settings', null);
    return HttpResponse.json(edgeStatus());
  }),

  // --- Nodes -------------------------------------------------------------------------------------
  http.get(`${API}/nodes`, () => guard('viewer') ?? HttpResponse.json({ items: db.nodes })),
  http.post(`${API}/nodes`, async ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateNodeInput);
    if (error) return error;
    const node: Node = {
      id: generateId('node'),
      name: data.name,
      status: 'pending',
      isEdge: false,
      lanIp: null,
      hostname: null,
      arch: null,
      agentVersion: null,
      protocolVersion: null,
      docker: null,
      lastSeenAt: null,
      joinedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    db.nodes.push(node);
    recordAudit('node.create', 'node', node.id, { name: node.name });
    db.emit('nodes', 'created', node.id);
    return HttpResponse.json({ node, joinToken: joinToken() }, { status: 201 });
  }),
  http.get(`${API}/nodes/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const node = db.nodes.find((item) => item.id === params.id);
    return node ? HttpResponse.json(node) : problem('not-found', 'No such node.');
  }),
  http.patch(`${API}/nodes/:id`, async ({ request, params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, UpdateNodeInput);
    if (error) return error;
    const node = db.nodes.find((item) => item.id === params.id);
    if (!node) return problem('not-found');
    Object.assign(node, data, { updatedAt: now() });
    db.emit('nodes', 'updated', node.id);
    return HttpResponse.json(node);
  }),
  http.delete(`${API}/nodes/:id`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const node = db.nodes.find((item) => item.id === params.id);
    if (!node) return problem('not-found');
    if (node.isEdge) return problem('conflict', 'Choose another edge node first.');
    if (db.apps.some((app) => app.nodeId === node.id))
      return problem('conflict', 'Apps still run on this node.');
    db.nodes = db.nodes.filter((item) => item !== node);
    recordAudit('node.delete', 'node', node.id);
    db.emit('nodes', 'deleted', node.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/nodes/:id/credential/rotate`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const node = db.nodes.find((item) => item.id === params.id);
    if (!node) return problem('not-found');
    if (node.status !== 'online') {
      return problem('conflict', 'The agent must be online to receive a new credential.');
    }
    recordAudit('node.credential.rotate', 'node', node.id);
    return HttpResponse.json(node);
  }),
  http.post(`${API}/nodes/:id/credential/revoke`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const node = db.nodes.find((item) => item.id === params.id);
    if (!node) return problem('not-found');
    Object.assign(node, { status: 'offline', updatedAt: now() });
    recordAudit('node.credential.revoke', 'node', node.id);
    db.emit('nodes', 'updated', node.id);
    return HttpResponse.json(node);
  }),
  http.post(`${API}/nodes/:id/join-token`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    if (!db.nodes.some((item) => item.id === params.id)) return problem('not-found');
    return HttpResponse.json(joinToken(), { status: 201 });
  }),

  // --- GitHub ------------------------------------------------------------------------------------
  http.get(
    `${API}/github/connections`,
    () => guard('viewer') ?? HttpResponse.json({ items: db.connections }),
  ),
  http.post(`${API}/github/connections/pat`, async ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreatePatConnectionInput);
    if (error) return error;
    const connection: GitHubConnection = {
      id: generateId('gh'),
      kind: 'pat',
      name: data.name,
      account: { login: 'alexmorgan', type: 'User' },
      app: null,
      webhooksEnabled: false,
      createdAt: now(),
      updatedAt: now(),
    };
    db.connections.push(connection);
    recordAudit('github.connect', 'github', connection.id, { kind: 'pat' });
    db.emit('github', 'created', connection.id);
    return HttpResponse.json(connection, { status: 201 });
  }),
  http.post(`${API}/github/connections/app-manifest/start`, async ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, StartAppManifestInput);
    if (error) return error;
    const base = db.settings.effectivePublicUrl ?? location.origin;
    const state = randomToken('').slice(0, 24);
    const start: AppManifestStart = {
      postUrl: `https://github.com/${data.organization ? `organizations/${data.organization}/` : ''}settings/apps/new?state=${state}`,
      state,
      manifest: {
        name: data.name ?? 'Launchway',
        url: base,
        hook_attributes: { url: `${base}/api/v1/webhooks/github`, active: true },
        redirect_url: `${base}/api/v1/github/connections/app-manifest/callback`,
        callback_urls: [`${base}/api/v1/github/connections/app-manifest/callback`],
        setup_url: `${base}/api/v1/github/connections/installation-callback`,
        description: 'Deploys GitHub releases with Launchway',
        public: false,
        default_permissions: { contents: 'read', metadata: 'read' },
        default_events: ['release'],
        setup_on_update: true,
        request_oauth_on_install: false,
      },
    };
    return HttpResponse.json(start);
  }),
  http.delete(`${API}/github/connections/:id`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    db.connections = db.connections.filter((item) => item.id !== params.id);
    db.emit('github', 'deleted', String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/github/repos`, ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const url = new URL(request.url);
    const connection = db.connections.find(
      (item) => item.id === url.searchParams.get('connectionId'),
    );
    if (!connection) return problem('not-found', 'Unknown connection.');
    const query = (url.searchParams.get('query') ?? '').toLowerCase();
    const repos = createRepos().filter(
      (repo) =>
        repo.owner === connection.account?.login && repo.fullName.toLowerCase().includes(query),
    );
    return HttpResponse.json(paginate(repos, url));
  }),
  http.get(`${API}/github/repos/:owner/:repo/releases`, ({ params, request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    return HttpResponse.json(
      paginate(createReleases(`${params.owner}/${params.repo}`), new URL(request.url)),
    );
  }),
];
