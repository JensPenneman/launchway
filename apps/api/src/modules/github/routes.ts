import { createRoute, z } from '@hono/zod-openapi';
import {
  AppManifestStart,
  CompleteAppManifestInput,
  CreatePatConnectionInput,
  GitHubConnection,
  GitHubConnectionId,
  GitHubConnectionList,
  GitHubLogin,
  GitHubRefQuery,
  GitHubReleaseListQuery,
  GitHubReleasePage,
  GitHubRepoListQuery,
  GitHubRepoName,
  GitHubRepoPage,
  GitRef,
  InstallationCallbackQuery,
  ResolvedGitRef,
  StartAppManifestInput,
} from '@launchway/contracts';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import {
  AUTHENTICATED,
  jsonBody,
  jsonResponse,
  PUBLIC,
  problemResponses,
} from '../../lib/openapi.js';
import { createGitHubService } from './service.js';
import { createWebhookHandler } from './webhooks.js';

const ConnectionParams = z.object({ id: GitHubConnectionId });
const RepoParams = z.object({ owner: GitHubLogin, repo: GitHubRepoName });
const RefParams = RepoParams.extend({ ref: GitRef });
const TAGS = ['GitHub'];
const redirectResponse = (description: string) => ({
  302: { description, headers: { Location: { schema: { type: 'string' as const } } } },
});

const listConnections = createRoute({
  method: 'get',
  path: '/github/connections',
  operationId: 'listGitHubConnections',
  tags: TAGS,
  summary: 'List GitHub connections',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(GitHubConnectionList, 'All connections'),
    ...problemResponses(401, 403),
  },
});

const getConnection = createRoute({
  method: 'get',
  path: '/github/connections/{id}',
  operationId: 'getGitHubConnection',
  tags: TAGS,
  summary: 'Get a GitHub connection',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: ConnectionParams },
  responses: {
    200: jsonResponse(GitHubConnection, 'The connection'),
    ...problemResponses(401, 403, 404),
  },
});

const deleteConnection = createRoute({
  method: 'delete',
  path: '/github/connections/{id}',
  operationId: 'deleteGitHubConnection',
  tags: TAGS,
  summary: 'Delete a GitHub connection',
  description: 'Refused while apps use it. The GitHub App itself stays on GitHub. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: ConnectionParams },
  responses: { 204: { description: 'Deleted' }, ...problemResponses(401, 403, 404, 409) },
});

const createPatConnection = createRoute({
  method: 'post',
  path: '/github/connections/pat',
  operationId: 'createGitHubPatConnection',
  tags: TAGS,
  summary: 'Connect GitHub with a personal access token',
  description:
    'Verifies the token with `GET /user` and stores it encrypted. Releases are polled every 5 ' +
    'minutes for apps with autoDeployReleases (no webhooks). Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { body: jsonBody(CreatePatConnectionInput) },
  responses: {
    201: jsonResponse(GitHubConnection, 'The new connection'),
    ...problemResponses(400, 401, 403, 502),
  },
});

const startManifest = createRoute({
  method: 'post',
  path: '/github/connections/app-manifest/start',
  operationId: 'startGitHubAppManifest',
  tags: TAGS,
  summary: 'Start creating a GitHub App (manifest flow)',
  description:
    'Returns the manifest and the URL the browser must post it to (form field `manifest`, JSON). ' +
    'GitHub then redirects to the callback below. Requires the platform public URL.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { body: jsonBody(StartAppManifestInput) },
  responses: {
    200: jsonResponse(AppManifestStart, 'Manifest, signed state and post URL'),
    ...problemResponses(400, 401, 403, 409),
  },
});

const manifestCallback = createRoute({
  method: 'get',
  path: '/github/connections/app-manifest/callback',
  operationId: 'completeGitHubAppManifest',
  tags: TAGS,
  summary: 'GitHub redirect after the app was created',
  description:
    'Exchanges the one-time code for the app credentials (stored encrypted) and redirects the ' +
    'browser to the settings page. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { query: CompleteAppManifestInput },
  responses: {
    ...redirectResponse('Redirect to <publicUrl>/settings/github?connection=<id>'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const installationCallback = createRoute({
  method: 'get',
  path: '/github/connections/{id}/installation-callback',
  operationId: 'completeGitHubAppInstallation',
  tags: TAGS,
  summary: 'GitHub redirect after the app was installed',
  description:
    'Checks with the app credentials that the installation belongs to this app, stores it and ' +
    'redirects the browser to the settings page. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  request: { params: ConnectionParams, query: InstallationCallbackQuery },
  responses: {
    ...redirectResponse('Redirect to <publicUrl>/settings/github?connection=<id>'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const listRepos = createRoute({
  method: 'get',
  path: '/github/repos',
  operationId: 'listGitHubRepos',
  tags: TAGS,
  summary: 'List repositories accessible through a connection',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { query: GitHubRepoListQuery },
  responses: {
    200: jsonResponse(GitHubRepoPage, 'A page of repositories'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const listReleases = createRoute({
  method: 'get',
  path: '/github/repos/{owner}/{repo}/releases',
  operationId: 'listGitHubReleases',
  tags: TAGS,
  summary: 'List the releases of a repository (newest first)',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: RepoParams, query: GitHubReleaseListQuery },
  responses: {
    200: jsonResponse(GitHubReleasePage, 'A page of releases'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const resolveRef = createRoute({
  method: 'get',
  path: '/github/repos/{owner}/{repo}/refs/{ref}',
  operationId: 'resolveGitHubRef',
  tags: TAGS,
  summary: 'Resolve a tag, branch or commit to a commit SHA',
  description: 'URL-encode slashes in the ref (`feature%2Fx`).',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: RefParams, query: GitHubRefQuery },
  responses: {
    200: jsonResponse(ResolvedGitRef, 'The resolved ref'),
    ...problemResponses(400, 401, 403, 404, 409, 502),
  },
});

const receiveWebhook = createRoute({
  method: 'post',
  path: '/webhooks/github',
  operationId: 'receiveGitHubWebhook',
  tags: TAGS,
  summary: 'GitHub App webhook receiver',
  description:
    'Called by GitHub. The raw body is verified against `X-Hub-Signature-256` with the webhook ' +
    'secret of the app named by `X-GitHub-Hook-Installation-Target-ID` before it is parsed; ' +
    'deliveries are deduplicated by `X-GitHub-Delivery`. Handles ping, release, installation and ' +
    'installation_repositories.',
  security: PUBLIC,
  responses: {
    204: { description: 'Accepted (processed, ignored or duplicate)' },
    ...problemResponses(400, 401),
  },
});

export function registerGitHubRoutes(api: Api, deps: Deps): void {
  const service = createGitHubService(deps);
  const webhooks = createWebhookHandler(deps);

  api.openapi(listConnections, async (c) => c.json(await service.list(), 200));
  api.openapi(getConnection, async (c) => c.json(await service.get(c.req.valid('param').id), 200));
  api.openapi(deleteConnection, async (c) => {
    await service.remove(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });
  api.openapi(createPatConnection, async (c) =>
    c.json(await service.createPat(c.req.valid('json'), requestActor(c)), 201),
  );
  api.openapi(startManifest, async (c) =>
    c.json(await service.startManifest(c.req.valid('json'), requestActor(c)), 200),
  );
  api.openapi(manifestCallback, async (c) =>
    c.redirect(await service.completeManifest(c.req.valid('query'), requestActor(c)), 302),
  );
  api.openapi(installationCallback, async (c) =>
    c.redirect(
      await service.completeInstallation(
        c.req.valid('param').id,
        c.req.valid('query'),
        requestActor(c),
      ),
      302,
    ),
  );

  api.openapi(listRepos, async (c) => c.json(await service.listRepos(c.req.valid('query')), 200));
  api.openapi(listReleases, async (c) => {
    const { owner, repo } = c.req.valid('param');
    return c.json(await service.listReleases(owner, repo, c.req.valid('query')), 200);
  });
  api.openapi(resolveRef, async (c) => {
    const { owner, repo, ref } = c.req.valid('param');
    return c.json(
      await service.resolveRef(owner, repo, ref, c.req.valid('query').connectionId),
      200,
    );
  });

  api.openapi(receiveWebhook, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    await webhooks.handle(
      {
        event: c.req.header('x-github-event'),
        deliveryId: c.req.header('x-github-delivery'),
        signature: c.req.header('x-hub-signature-256'),
        targetType: c.req.header('x-github-hook-installation-target-type'),
        targetId: c.req.header('x-github-hook-installation-target-id'),
      },
      body,
    );
    return c.body(null, 204);
  });
}
