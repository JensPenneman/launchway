import {
  AppManifestStart,
  type CreatePatConnectionInput,
  GitHubConnection,
  GitHubConnectionList,
  GitHubReleasePage,
  GitHubRepoPage,
  type StartAppManifestInput,
} from '@slipway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

export const connectionsQuery = queryOptions({
  queryKey: [...keys.github, 'connections'],
  queryFn: ({ signal }) => request('/github/connections', { schema: GitHubConnectionList, signal }),
});

export function createPatConnection(input: CreatePatConnectionInput) {
  return request('/github/connections/pat', {
    method: 'POST',
    body: input,
    schema: GitHubConnection,
  });
}

export function startAppManifest(input: StartAppManifestInput) {
  return request('/github/connections/app-manifest/start', {
    method: 'POST',
    body: input,
    schema: AppManifestStart,
  });
}

export function deleteConnection(id: string) {
  return request(`/github/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Navigates to GitHub with the manifest as a form POST (the manifest flow does not accept it in
 * the query string). GitHub redirects to the API's manifest callback, which stores the app and
 * redirects the browser to `/settings/github?connection=<id>`.
 */
export function submitManifestForm(start: AppManifestStart): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = start.postUrl;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = JSON.stringify(start.manifest);
  form.append(field);
  document.body.append(form);
  form.submit();
}

export function reposQuery(connectionId: string, query: string) {
  return queryOptions({
    queryKey: [...keys.github, 'repos', connectionId, query],
    queryFn: ({ signal }) =>
      request('/github/repos', {
        query: { connectionId, query, limit: 30 },
        schema: GitHubRepoPage,
        signal,
      }),
    enabled: connectionId !== '',
    staleTime: 60_000,
  });
}

export function releasesQuery(connectionId: string, owner: string, repo: string) {
  return queryOptions({
    queryKey: [...keys.github, 'releases', connectionId, owner, repo],
    queryFn: ({ signal }) =>
      request(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`, {
        query: { connectionId, limit: 30 },
        schema: GitHubReleasePage,
        signal,
      }),
    staleTime: 60_000,
  });
}
