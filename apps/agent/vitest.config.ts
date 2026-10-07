import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see the `@launchway/source` export condition).
const conditions = ['@launchway/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'agent',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
