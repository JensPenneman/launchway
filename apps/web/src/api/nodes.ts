import {
  CreatedNode,
  Node,
  NodeJoinToken,
  NodeList,
  type UpdateNodeInput,
} from '@launchway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { request } from './request';

const nodePath = (id: string) => `/nodes/${encodeURIComponent(id)}`;

export const nodesQuery = queryOptions({
  queryKey: [...keys.nodes, 'list'],
  queryFn: ({ signal }) => request('/nodes', { schema: NodeList, signal }),
});

export function nodeQuery(id: string) {
  return queryOptions({
    queryKey: [...keys.nodes, 'detail', id],
    queryFn: ({ signal }) => request(nodePath(id), { schema: Node, signal }),
  });
}

export function createNode(name: string) {
  return request('/nodes', { method: 'POST', body: { name }, schema: CreatedNode });
}

export function renameNode(id: string, name: string) {
  return request(nodePath(id), { method: 'PATCH', body: { name }, schema: Node });
}

/** Partial update; `allowedBindRoots` replaces the whole list (admin only). */
export function updateNode(id: string, input: UpdateNodeInput) {
  return request(nodePath(id), { method: 'PATCH', body: input, schema: Node });
}

export function deleteNode(id: string) {
  return request(nodePath(id), { method: 'DELETE' });
}

/** Issues a new agent credential and hands it to the connected agent (409 when offline). */
export function rotateCredential(id: string) {
  return request(`${nodePath(id)}/credential/rotate`, { method: 'POST', schema: Node });
}

/** Invalidates the agent credential and join tokens; the agent disconnects. */
export function revokeCredential(id: string) {
  return request(`${nodePath(id)}/credential/revoke`, { method: 'POST', schema: Node });
}

export function createJoinToken(id: string) {
  return request(`${nodePath(id)}/join-token`, { method: 'POST', schema: NodeJoinToken });
}
