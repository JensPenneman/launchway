import {
  type App,
  CreateAppInput,
  CreateDeploymentInput,
  type Deployment,
  type DeploymentStatus,
  type EnvVar,
  generateId,
  isInProgressStatus,
  isTerminalStatus,
  type LogLine,
  SetEnvVarsInput,
  UpdateAppInput,
  UpdateEnvVarInput,
} from '@slipway/contracts';
import { HttpResponse, http, sse } from 'msw';
import { db } from '../db';
import {
  API,
  guard,
  now,
  paginate,
  parseBody,
  problem,
  randomSha,
  recordAudit,
  slugify,
} from '../util';

type LogEvents = { log: string; status: string; end: string };

function findApp(id: unknown): App | undefined {
  return db.apps.find((app) => app.id === id);
}

const STAGES: [DeploymentStatus, number, [LogLine['stream'], string][]][] = [
  [
    'cloning',
    400,
    [
      ['system', 'Cloning the repository'],
      ['stdout', "Cloning into '/var/lib/slipway/apps/…'"],
    ],
  ],
  [
    'building',
    1_000,
    [
      ['system', 'Policy check passed'],
      ['system', 'Building images'],
      ['stdout', '#1 [internal] load build definition from Dockerfile'],
      ['stdout', '#4 [build 3/6] RUN pnpm install --frozen-lockfile'],
      ['stdout', '#8 [build 6/6] RUN pnpm build'],
      ['stdout', '#9 exporting to image done'],
    ],
  ],
  [
    'starting',
    1_800,
    [
      ['system', 'Starting containers'],
      ['stderr', ' Container web-1  Started'],
      ['stderr', ' Container web-1  Waiting'],
    ],
  ],
  ['running', 2_600, [['system', 'All services are healthy']]],
];

/** Walks a new deployment through the state machine like an agent would. */
function simulate(deployment: Deployment, app: App): void {
  for (const [status, delay, lines] of STAGES) {
    setTimeout(() => {
      if (isTerminalStatus(deployment.status)) return;
      for (const [stream, line] of lines) db.appendLog(deployment.id, stream, line);
      if (status !== 'running') {
        db.updateDeployment(deployment.id, {
          status,
          ...(status === 'cloning' ? { startedAt: now() } : {}),
        });
        return;
      }
      const previous = db.deployments.find((item) => item.id === app.activeDeploymentId);
      if (previous) db.updateDeployment(previous.id, { status: 'superseded', finishedAt: now() });
      db.updateDeployment(deployment.id, {
        status: 'running',
        services: [
          {
            service: 'web',
            containerId: randomSha().slice(0, 12),
            state: 'running',
            health: 'healthy',
            publishedPorts: [],
          },
        ],
      });
      app.activeDeploymentId = deployment.id;
      app.updatedAt = now();
      db.emit('apps', 'updated', app.id);
    }, delay);
  }
}

/** Shape of `AppRuntimeStatus` (`GET /apps/{id}/status`). */
function runtimeStatus(app: App) {
  const node = db.nodes.find((item) => item.id === app.nodeId);
  const active = db.deployments.find((item) => item.id === app.activeDeploymentId);
  return {
    appId: app.id,
    nodeId: app.nodeId,
    nodeOnline: node?.status === 'online',
    source: node?.status === 'online' ? 'agent' : 'last-deployment',
    activeDeploymentId: active?.id ?? null,
    services: active?.services ?? [],
  };
}

function setEnv(appId: string, key: string, value: string | undefined, secret: boolean): EnvVar {
  const list = db.envOf(appId);
  const existing = list.find((variable) => variable.key === key);
  // The mock keeps values in clear text but masks secrets like the API.
  if (existing) {
    Object.assign(existing, {
      secret,
      value: secret ? null : (value ?? existing.value),
      updatedAt: now(),
    });
    return existing;
  }
  const created: EnvVar = {
    id: generateId('env'),
    key,
    secret,
    value: secret ? null : (value ?? ''),
    createdAt: now(),
    updatedAt: now(),
  };
  list.push(created);
  return created;
}

export const appHandlers = [
  http.get(`${API}/apps`, ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const url = new URL(request.url);
    const nodeId = url.searchParams.get('nodeId');
    return HttpResponse.json(
      paginate(
        db.apps.filter((app) => !nodeId || app.nodeId === nodeId),
        url,
      ),
    );
  }),
  http.post(`${API}/apps`, async ({ request }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateAppInput);
    if (error) return error;
    const slug = data.slug ?? slugify(data.name);
    if (db.apps.some((app) => app.slug === slug)) {
      return problem('conflict', `An app with the slug "${slug}" already exists.`);
    }
    const app: App = {
      id: generateId('app'),
      slug,
      name: data.name,
      description: data.description ?? null,
      connectionId: data.connectionId,
      repository: data.repository,
      composeFiles: data.dockerfile ? null : (data.composeFiles ?? ['compose.yaml']),
      dockerfile: data.dockerfile ?? null,
      context: data.dockerfile ? (data.context ?? '.') : null,
      nodeId: data.nodeId,
      autoDeployReleases: data.autoDeployReleases,
      activeDeploymentId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    db.apps.push(app);
    db.env.set(app.id, []);
    recordAudit('app.create', 'app', app.id, { name: app.name });
    db.emit('apps', 'created', app.id);
    return HttpResponse.json(app, { status: 201 });
  }),
  http.get(`${API}/apps/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const app = findApp(params.id);
    return app ? HttpResponse.json(app) : problem('not-found', 'No such app.');
  }),
  http.patch(`${API}/apps/:id`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const app = findApp(params.id);
    if (!app) return problem('not-found');
    const { data, error } = await parseBody(request, UpdateAppInput);
    if (error) return error;
    const { composeFiles, dockerfile, context, ...rest } = data;
    Object.assign(app, rest, { updatedAt: now() });
    if (composeFiles) Object.assign(app, { composeFiles, dockerfile: null, context: null });
    if (dockerfile) Object.assign(app, { dockerfile, context: context ?? '.', composeFiles: null });
    recordAudit('app.update', 'app', app.id, { fields: Object.keys(data) });
    db.emit('apps', 'updated', app.id);
    return HttpResponse.json(app);
  }),
  http.delete(`${API}/apps/:id`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const app = findApp(params.id);
    if (!app) return problem('not-found');
    db.apps = db.apps.filter((item) => item !== app);
    db.routes = db.routes.filter(
      (route) => !(route.target.kind === 'app' && route.target.appId === app.id),
    );
    recordAudit('app.delete', 'app', app.id);
    db.emit('apps', 'deleted', app.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/apps/:id/stop`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const app = findApp(params.id);
    if (!app) return problem('not-found');
    if (app.activeDeploymentId) {
      db.updateDeployment(app.activeDeploymentId, { status: 'stopped', finishedAt: now() });
    }
    app.activeDeploymentId = null;
    recordAudit('app.stop', 'app', app.id);
    db.emit('apps', 'updated', app.id);
    return HttpResponse.json(runtimeStatus(app));
  }),
  http.get(`${API}/apps/:id/status`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const app = findApp(params.id);
    return app ? HttpResponse.json(runtimeStatus(app)) : problem('not-found');
  }),
  sse<LogEvents>(`${API}/apps/:id/logs`, ({ client, params, request }) => {
    const app = findApp(params.id);
    if (!app || !db.role()) {
      client.error();
      return;
    }
    const service = new URL(request.url).searchParams.get('service') ?? 'web';
    const send = (line: string, stream: 'stdout' | 'stderr' = 'stdout') =>
      client.send({
        event: 'log',
        data: JSON.stringify({ service, timestamp: now(), stream, line }),
      });
    send('Listening on http://0.0.0.0:8080');
    send('GET /health 200 1.2ms');
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      send(
        count % 5 === 0
          ? 'warn: slow query (412ms)'
          : `GET /api/trails?page=${count} 200 ${8 + count}ms`,
        count % 5 === 0 ? 'stderr' : 'stdout',
      );
    }, 1_000);
    request.signal.addEventListener('abort', () => clearInterval(timer));
  }),

  // --- Environment -------------------------------------------------------------------------------
  http.get(`${API}/apps/:id/env`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    if (!findApp(params.id)) return problem('not-found');
    return HttpResponse.json({ items: db.envOf(String(params.id)) });
  }),
  http.put(`${API}/apps/:id/env`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const appId = String(params.id);
    if (!findApp(appId)) return problem('not-found');
    const { data, error } = await parseBody(request, SetEnvVarsInput);
    if (error) return error;
    const keys = new Set(data.variables.map((variable) => variable.key));
    db.env.set(
      appId,
      db.envOf(appId).filter((variable) => keys.has(variable.key)),
    );
    for (const variable of data.variables)
      setEnv(appId, variable.key, variable.value, variable.secret);
    recordAudit('env.set', 'app', appId, { keys: [...keys], values: '[redacted]' });
    db.emit('env', 'updated', appId);
    return HttpResponse.json({ items: db.envOf(appId) });
  }),
  http.put(`${API}/apps/:id/env/:key`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const appId = String(params.id);
    if (!findApp(appId)) return problem('not-found');
    const { data, error } = await parseBody(request, UpdateEnvVarInput);
    if (error) return error;
    const key = String(params.key);
    const existing = db.envOf(appId).find((variable) => variable.key === key);
    const variable = setEnv(appId, key, data.value, data.secret ?? existing?.secret ?? false);
    recordAudit('env.set', 'app', appId, { keys: [key], values: '[redacted]' });
    db.emit('env', 'updated', appId);
    return HttpResponse.json(variable);
  }),
  http.delete(`${API}/apps/:id/env/:key`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const appId = String(params.id);
    db.env.set(
      appId,
      db.envOf(appId).filter((variable) => variable.key !== params.key),
    );
    recordAudit('env.delete', 'app', appId, { keys: [String(params.key)] });
    db.emit('env', 'deleted', appId);
    return new HttpResponse(null, { status: 204 });
  }),

  // --- Deployments -------------------------------------------------------------------------------
  http.get(`${API}/apps/:id/deployments`, ({ params, request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    if (!findApp(params.id)) return problem('not-found');
    const items = db.deployments
      .filter((deployment) => deployment.appId === params.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json(paginate(items, new URL(request.url)));
  }),
  http.post(`${API}/apps/:id/deployments`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const app = findApp(params.id);
    if (!app) return problem('not-found');
    const { data, error } = await parseBody(request, CreateDeploymentInput);
    if (error) return error;
    const user = db.currentUser();
    const deployment: Deployment = {
      id: generateId('dep'),
      appId: app.id,
      nodeId: app.nodeId,
      ref: data.ref,
      commitSha: randomSha(),
      trigger: 'manual',
      status: 'queued',
      statusMessage: null,
      triggeredBy: user?.id ?? null,
      services: [],
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      updatedAt: now(),
    };
    db.deployments.push(deployment);
    db.logs.set(deployment.id, []);
    db.appendLog(deployment.id, 'system', `Queued ${data.ref} for ${app.slug}`);
    recordAudit('deployment.create', 'deployment', deployment.id, { ref: data.ref });
    db.emit('deployments', 'created', deployment.id);
    simulate(deployment, app);
    return HttpResponse.json(deployment, { status: 201 });
  }),
  http.get(`${API}/deployments/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const deployment = db.deployments.find((item) => item.id === params.id);
    return deployment ? HttpResponse.json(deployment) : problem('not-found');
  }),
  http.post(`${API}/deployments/:id/cancel`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const deployment = db.deployments.find((item) => item.id === params.id);
    if (!deployment) return problem('not-found');
    if (!isInProgressStatus(deployment.status)) {
      return problem('conflict', `A ${deployment.status} deployment cannot be cancelled.`);
    }
    db.appendLog(deployment.id, 'system', 'Cancelled by user');
    db.updateDeployment(deployment.id, { status: 'cancelled', finishedAt: now() });
    recordAudit('deployment.cancel', 'deployment', deployment.id);
    return HttpResponse.json(deployment, { status: 202 });
  }),
  sse<LogEvents>(`${API}/deployments/:id/logs`, ({ client, params, request }) => {
    const deployment = db.deployments.find((item) => item.id === params.id);
    if (!deployment || !db.role()) {
      client.error();
      return;
    }
    for (const line of db.logs.get(deployment.id) ?? [])
      client.send({ event: 'log', data: JSON.stringify(line) });
    const end = () => {
      client.send({ event: 'end', data: JSON.stringify({ status: deployment.status }) });
      client.close();
    };
    if (isTerminalStatus(deployment.status) || deployment.status === 'running') {
      end();
      return;
    }
    const unsubscribe = db.onDeployment(deployment.id, (update) => {
      if ('seq' in update) {
        client.send({ event: 'log', data: JSON.stringify(update) });
        return;
      }
      client.send({ event: 'status', data: JSON.stringify({ status: update.status }) });
      if (isTerminalStatus(update.status) || update.status === 'running') {
        unsubscribe();
        end();
      }
    });
    request.signal.addEventListener('abort', unsubscribe);
  }),
];
