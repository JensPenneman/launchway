import type { EventTopic } from '@slipway/contracts';
import type { QueryKey } from '@tanstack/react-query';

/**
 * Query key roots. Every key starts with one of these, so a platform event (`GET /events`) can
 * invalidate a whole resource family with a prefix match.
 */
export const keys = {
  setup: ['setup'] as const,
  me: ['me'] as const,
  sessions: ['me', 'sessions'] as const,
  passkeys: ['me', 'passkeys'] as const,
  users: ['users'] as const,
  invitations: ['invitations'] as const,
  tokens: ['tokens'] as const,
  audit: ['audit'] as const,
  settings: ['settings'] as const,
  github: ['github'] as const,
  apps: ['apps'] as const,
  env: ['env'] as const,
  deployments: ['deployments'] as const,
  domains: ['domains'] as const,
  routes: ['routes'] as const,
  dns: ['dns'] as const,
  nodes: ['nodes'] as const,
  edge: ['edge'] as const,
};

/** Query families to refresh when the change feed reports a change on `topic`. */
export function keysForTopic(topic: EventTopic): QueryKey[] {
  switch (topic) {
    case 'apps':
      return [keys.apps, keys.routes, keys.edge];
    case 'deployments':
      // A deployment reaching `running` changes the app's active deployment and status.
      return [keys.deployments, keys.apps];
    case 'env':
      return [keys.env];
    case 'nodes':
      return [keys.nodes];
    case 'domains':
      return [keys.domains, keys.edge];
    case 'routes':
      return [keys.routes, keys.edge];
    case 'dns':
      return [keys.dns, keys.domains];
    case 'github':
      return [keys.github];
    case 'settings':
      return [keys.settings, keys.edge, [...keys.dns, 'ddns']];
    case 'users':
      return [keys.users, keys.me];
    case 'invitations':
      return [keys.invitations];
    case 'tokens':
      return [keys.tokens];
  }
}
