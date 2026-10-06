import { defineConfig } from 'vitest/config';

// Lets editors and `pnpm exec vitest` at the root run every project at once.
// CI and `pnpm test` go through Turborepo, which runs each package's own config.
export default defineConfig({
  test: {
    projects: [
      'packages/contracts',
      'apps/api/vitest.config.ts',
      'apps/api/vitest.integration.config.ts',
      'apps/agent',
      'apps/web',
    ],
  },
});
