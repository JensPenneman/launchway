import type { Api, Deps } from '../deps.js';
import { registerAuditRoutes } from './audit/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerDnsRoutes } from './dns/routes.js';
import { registerDomainsRoutes } from './domains/routes.js';
import { registerEventsRoutes } from './events/routes.js';
import { registerHealthRoutes } from './health/routes.js';
import { registerInvitationsRoutes } from './invitations/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerTokensRoutes } from './tokens/routes.js';
import { registerUsersRoutes } from './users/routes.js';

export interface ModuleDefinition {
  /** Module name, matching the directory under src/modules. */
  readonly name: string;
  /**
   * Where the module's router is mounted:
   * - `v1`:  /api/v1 (the public REST API; paths like `/settings`)
   * - `api`: /api (unversioned endpoints: health, the agent WebSocket)
   */
  readonly mount: 'v1' | 'api';
  readonly register: (api: Api, deps: Deps) => void;
}

/**
 * The single registry of API modules. To add a module, create
 * src/modules/<name>/routes.ts exporting `register<Name>Routes(api, deps)` and add one line here.
 */
export const modules: readonly ModuleDefinition[] = [
  { name: 'health', mount: 'api', register: registerHealthRoutes },
  { name: 'settings', mount: 'v1', register: registerSettingsRoutes },
  { name: 'auth', mount: 'v1', register: registerAuthRoutes },
  { name: 'users', mount: 'v1', register: registerUsersRoutes },
  { name: 'invitations', mount: 'v1', register: registerInvitationsRoutes },
  { name: 'tokens', mount: 'v1', register: registerTokensRoutes },
  { name: 'audit', mount: 'v1', register: registerAuditRoutes },
  { name: 'events', mount: 'v1', register: registerEventsRoutes },
  { name: 'dns', mount: 'v1', register: registerDnsRoutes },
  { name: 'domains', mount: 'v1', register: registerDomainsRoutes },
];

export function registerModules(routers: Record<ModuleDefinition['mount'], Api>, deps: Deps): void {
  for (const module of modules) module.register(routers[module.mount], deps);
}
