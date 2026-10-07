import { type CreatePreviewInput, Preview, PreviewPage } from '@launchway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

const previewPath = (id: string) => `/previews/${encodeURIComponent(id)}`;

/** Previews of an app, newest first (open and recently closed ones). */
export function appPreviewsQuery(appId: string) {
  return queryOptions({
    queryKey: [...keys.previews, 'list', appId],
    queryFn: ({ signal }) =>
      request(`/apps/${encodeURIComponent(appId)}/previews`, {
        query: { limit: 100 },
        schema: PreviewPage,
        signal,
      }),
  });
}

/** Open previews of all apps (overview). */
export const openPreviewsQuery = queryOptions({
  queryKey: [...keys.previews, 'open'],
  queryFn: ({ signal }) =>
    request('/previews', { query: { open: true, limit: 100 }, schema: PreviewPage, signal }),
});

export function createPreview(appId: string, input: CreatePreviewInput) {
  return request(`/apps/${encodeURIComponent(appId)}/previews`, {
    method: 'POST',
    body: input,
    schema: Preview,
  });
}

export function redeployPreview(id: string) {
  return request(`${previewPath(id)}/redeploy`, { method: 'POST', schema: Preview });
}

export function closePreview(id: string) {
  return request(previewPath(id), { method: 'DELETE', schema: Preview });
}
