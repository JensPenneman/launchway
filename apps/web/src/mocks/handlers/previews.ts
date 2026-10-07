import {
  CreatePreviewInput,
  type Deployment,
  generateId,
  type Preview,
  previewEnvironmentName,
} from '@launchway/contracts';
import { HttpResponse, http } from 'msw';
import { db } from '../db';
import { API, guard, now, paginate, parseBody, problem, randomSha, recordAudit } from '../util';

function present(preview: Preview): Preview {
  const last = db.deployments
    .filter((deployment) => deployment.previewId === preview.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    ...preview,
    lastDeployment: last ? { id: last.id, status: last.status, commitSha: last.commitSha } : null,
  };
}

/** Queues a deployment of the preview's head; the mock lets it run after a short while. */
function deployPreview(preview: Preview): void {
  const app = db.apps.find((item) => item.id === preview.appId);
  if (!app) return;
  const deployment: Deployment = {
    id: generateId('dep'),
    appId: app.id,
    nodeId: app.nodeId,
    ref: preview.headSha,
    commitSha: preview.headSha,
    trigger: 'preview',
    previewId: preview.id,
    environmentName: preview.environmentName,
    status: 'queued',
    statusMessage: null,
    failureReason: null,
    retryCount: 0,
    nextAttemptAt: null,
    triggeredBy: db.currentUser()?.id ?? null,
    services: [],
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    updatedAt: now(),
  };
  db.deployments.unshift(deployment);
  Object.assign(preview, { status: 'deploying', statusMessage: null, updatedAt: now() });
  db.emit('deployments', 'created', deployment.id);
  setTimeout(() => {
    for (const other of db.deployments) {
      if (other.previewId === preview.id && other.status === 'running') {
        db.updateDeployment(other.id, { status: 'superseded', finishedAt: now() });
      }
    }
    db.updateDeployment(deployment.id, { status: 'running', startedAt: now() });
    Object.assign(preview, {
      status: 'running',
      activeDeploymentId: deployment.id,
      updatedAt: now(),
    });
    db.emit('previews', 'updated', preview.id);
  }, 1500);
}

export const previewHandlers = [
  http.get(`${API}/apps/:id/previews`, ({ request, params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    if (!db.apps.some((app) => app.id === params.id)) return problem('not-found');
    const items = db.previews
      .filter((preview) => preview.appId === params.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(present);
    return HttpResponse.json(paginate(items, new URL(request.url)));
  }),
  http.get(`${API}/previews`, ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const url = new URL(request.url);
    const open = url.searchParams.get('open');
    const items = db.previews
      .filter((preview) =>
        open === 'true'
          ? preview.status !== 'closed'
          : open === 'false'
            ? preview.status === 'closed'
            : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(present);
    return HttpResponse.json(paginate(items, url));
  }),
  http.get(`${API}/previews/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const preview = db.previews.find((item) => item.id === params.id);
    return preview ? HttpResponse.json(present(preview)) : problem('not-found');
  }),
  http.post(`${API}/apps/:id/previews`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const app = db.apps.find((item) => item.id === params.id);
    if (!app) return problem('not-found');
    if (!app.previews.enabled) return problem('conflict', 'Previews are turned off for this app');
    const base = db.settings.previewBaseDomain;
    if (!base) {
      return problem(
        'conflict',
        'Set the preview base domain in the platform settings to use previews',
      );
    }
    const { data, error } = await parseBody(request, CreatePreviewInput);
    if (error) return error;
    let preview = db.previews.find(
      (item) => item.appId === app.id && item.prNumber === data.prNumber,
    );
    if (!preview) {
      const hostname = app.previews.hostTemplate
        .replaceAll('{slug}', app.slug)
        .replaceAll('{number}', String(data.prNumber))
        .replaceAll('{base}', base);
      preview = {
        id: generateId('prv'),
        appId: app.id,
        prNumber: data.prNumber,
        prTitle: `Pull request #${data.prNumber}`,
        branch: `feature/pr-${data.prNumber}`,
        headSha: randomSha(),
        environmentName: previewEnvironmentName(data.prNumber),
        hostname,
        url: `https://${hostname}`,
        domainId: generateId('dom'),
        routeId: generateId('rt'),
        status: 'pending',
        statusMessage: null,
        activeDeploymentId: null,
        lastDeployment: null,
        createdAt: now(),
        updatedAt: now(),
        closedAt: null,
      };
      db.previews.push(preview);
      recordAudit('preview.create', 'preview', preview.id, { prNumber: data.prNumber });
    } else {
      Object.assign(preview, { status: 'pending', closedAt: null, updatedAt: now() });
      recordAudit('preview.reopen', 'preview', preview.id, { prNumber: data.prNumber });
    }
    deployPreview(preview);
    db.emit('previews', 'created', preview.id);
    return HttpResponse.json(present(preview), { status: 201 });
  }),
  http.post(`${API}/previews/:id/redeploy`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const preview = db.previews.find((item) => item.id === params.id);
    if (!preview) return problem('not-found');
    if (preview.status === 'closed' || preview.status === 'closing') {
      return problem('conflict', 'The preview is closed; open it again from its pull request');
    }
    deployPreview(preview);
    db.emit('previews', 'updated', preview.id);
    return HttpResponse.json(present(preview));
  }),
  http.delete(`${API}/previews/:id`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const preview = db.previews.find((item) => item.id === params.id);
    if (!preview) return problem('not-found');
    for (const deployment of db.deployments) {
      if (deployment.previewId === preview.id && deployment.status === 'running') {
        db.updateDeployment(deployment.id, { status: 'stopped', finishedAt: now() });
      }
    }
    Object.assign(preview, {
      status: 'closed',
      statusMessage: null,
      activeDeploymentId: null,
      domainId: null,
      routeId: null,
      closedAt: now(),
      updatedAt: now(),
    });
    recordAudit('preview.close', 'preview', preview.id, { prNumber: preview.prNumber });
    db.emit('previews', 'updated', preview.id);
    return HttpResponse.json(present(preview));
  }),
];
