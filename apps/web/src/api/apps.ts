import {
  App,
  AppPage,
  AppRuntimeStatus,
  type CreateAppInput,
  type CreateDeploymentInput,
  Deployment,
  DeploymentPage,
  EnvVar,
  EnvVarList,
  type SetEnvVarsInput,
  type UpdateAppInput,
  type UpdateEnvVarInput,
  type z,
} from '@slipway/contracts';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { buildUrl, request } from './request';

const appPath = (id: string) => `/apps/${encodeURIComponent(id)}`;
const deploymentPath = (id: string) => `/deployments/${encodeURIComponent(id)}`;

// --- Apps --------------------------------------------------------------------------------------

export const appsQuery = queryOptions({
  queryKey: [...keys.apps, 'list'],
  queryFn: ({ signal }) => request('/apps', { query: { limit: 100 }, schema: AppPage, signal }),
});

export function appQuery(id: string) {
  return queryOptions({
    queryKey: [...keys.apps, 'detail', id],
    queryFn: ({ signal }) => request(appPath(id), { schema: App, signal }),
  });
}

export function appStatusQuery(id: string) {
  return queryOptions({
    queryKey: [...keys.apps, 'status', id],
    queryFn: ({ signal }) => request(`${appPath(id)}/status`, { schema: AppRuntimeStatus, signal }),
    refetchInterval: 30_000,
  });
}

export function createApp(input: z.input<typeof CreateAppInput>) {
  return request('/apps', { method: 'POST', body: input, schema: App });
}

export function updateApp(id: string, input: z.input<typeof UpdateAppInput>) {
  return request(appPath(id), { method: 'PATCH', body: input, schema: App });
}

export function stopApp(id: string) {
  return request(`${appPath(id)}/stop`, { method: 'POST' });
}

/** Removes the app (`compose down`); `removeVolumes` also deletes its named volumes. */
export function deleteApp(id: string, options: { removeVolumes: boolean; force: boolean }) {
  return request(appPath(id), {
    method: 'DELETE',
    query: {
      removeVolumes: options.removeVolumes || undefined,
      force: options.force || undefined,
    },
  });
}

export function appLogsUrl(id: string, service: string | undefined, tail = 200): string {
  return buildUrl(`${appPath(id)}/logs`, { service, tail, follow: true });
}

// --- Environment -------------------------------------------------------------------------------

export function envQuery(appId: string) {
  return queryOptions({
    queryKey: [...keys.env, appId],
    queryFn: ({ signal }) => request(`${appPath(appId)}/env`, { schema: EnvVarList, signal }),
  });
}

export function setEnvVars(appId: string, input: z.input<typeof SetEnvVarsInput>) {
  return request(`${appPath(appId)}/env`, { method: 'PUT', body: input, schema: EnvVarList });
}

export function putEnvVar(appId: string, key: string, input: UpdateEnvVarInput) {
  return request(`${appPath(appId)}/env/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: input,
    schema: EnvVar,
  });
}

export function deleteEnvVar(appId: string, key: string) {
  return request(`${appPath(appId)}/env/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

// --- Deployments -------------------------------------------------------------------------------

export function deploymentsQuery(appId: string, limit = 20) {
  return infiniteQueryOptions({
    queryKey: [...keys.deployments, 'list', appId, limit],
    queryFn: ({ signal, pageParam }) =>
      request(`${appPath(appId)}/deployments`, {
        query: { limit, cursor: pageParam },
        schema: DeploymentPage,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** First page only, for summaries (overview, app overview). */
export function recentDeploymentsQuery(appId: string, limit = 5) {
  return queryOptions({
    queryKey: [...keys.deployments, 'recent', appId, limit],
    queryFn: ({ signal }) =>
      request(`${appPath(appId)}/deployments`, {
        query: { limit },
        schema: DeploymentPage,
        signal,
      }),
  });
}

export function deploymentQuery(id: string) {
  return queryOptions({
    queryKey: [...keys.deployments, 'detail', id],
    queryFn: ({ signal }) => request(deploymentPath(id), { schema: Deployment, signal }),
  });
}

export function createDeployment(appId: string, input: CreateDeploymentInput) {
  return request(`${appPath(appId)}/deployments`, {
    method: 'POST',
    body: input,
    schema: Deployment,
  });
}

export function cancelDeployment(id: string) {
  return request(`${deploymentPath(id)}/cancel`, { method: 'POST' });
}

export function deploymentLogsUrl(id: string): string {
  return buildUrl(`${deploymentPath(id)}/logs`, { follow: true });
}
