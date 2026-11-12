import {
  AutomationChange,
  AutomationRunList,
  type UpdateAppAutomation,
} from '@launchway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

const path = (appId: string) => `/apps/${encodeURIComponent(appId)}/automation`;

/** The last 20 automation runs of an app, newest first. */
export function automationRunsQuery(appId: string) {
  return queryOptions({
    queryKey: [...keys.apps, 'automation', appId],
    queryFn: ({ signal }) => request(`${path(appId)}/runs`, { schema: AutomationRunList, signal }),
    refetchInterval: 30_000,
  });
}

/** Needs an admin session signed in with a passkey. A pause or a move away from `on` waits for the disable sweep. */
export function updateAutomation(appId: string, input: UpdateAppAutomation) {
  return request(path(appId), { method: 'PUT', body: input, schema: AutomationChange });
}

export function pauseAutomation(appId: string) {
  return request(`${path(appId)}/pause`, { method: 'POST', schema: AutomationChange });
}
