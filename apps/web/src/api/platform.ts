import { EdgeConfig, Settings, type UpdateSettingsInput } from '@slipway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

export const settingsQuery = queryOptions({
  queryKey: keys.settings,
  queryFn: ({ signal }) => request('/settings', { schema: Settings, signal }),
});

export function updateSettings(input: UpdateSettingsInput) {
  return request('/settings', { method: 'PATCH', body: input, schema: Settings });
}

export const edgeConfigQuery = queryOptions({
  queryKey: [...keys.edge, 'config'],
  queryFn: ({ signal }) => request('/edge/config', { schema: EdgeConfig, signal }),
});

export function reloadEdge() {
  return request('/edge/reload', { method: 'POST', schema: EdgeConfig });
}
