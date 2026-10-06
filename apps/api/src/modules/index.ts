import type { Api, Deps } from '../deps.js';
import { registerHealthRoutes } from './health/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';

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
];

export function registerModules(routers: Record<ModuleDefinition['mount'], Api>, deps: Deps): void {
  for (const module of modules) module.register(routers[module.mount], deps);
}
