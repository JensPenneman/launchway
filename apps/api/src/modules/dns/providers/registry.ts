import type { DnsProviderKind } from '@launchway/contracts';
import { cloudflareProvider } from './cloudflare.js';
import { manualProvider } from './manual.js';
import type { DnsProviderDefinition } from './types.js';

export interface DnsProviderRegistry {
  get(kind: DnsProviderKind): DnsProviderDefinition | undefined;
  list(): DnsProviderDefinition[];
  /** Adds a provider kind; throws when the kind is already registered. */
  register<C>(definition: DnsProviderDefinition<C>): void;
}

export function createDnsProviderRegistry(
  definitions: readonly DnsProviderDefinition[] = [],
): DnsProviderRegistry {
  const byKind = new Map<string, DnsProviderDefinition>();
  const registry: DnsProviderRegistry = {
    get: (kind) => byKind.get(kind),
    list: () => [...byKind.values()].sort((a, b) => a.label.localeCompare(b.label)),
    register(definition) {
      if (byKind.has(definition.kind)) {
        throw new Error(`DNS provider "${definition.kind}" is already registered`);
      }
      // The definition validates its own credentials before `create` sees them.
      byKind.set(definition.kind, definition as DnsProviderDefinition);
    },
  };
  for (const definition of definitions) registry.register(definition);
  return registry;
}

/** The providers Launchway ships with. Add new providers here (see README.md). */
export const dnsProviders: DnsProviderRegistry = createDnsProviderRegistry([
  cloudflareProvider,
  manualProvider,
]);
