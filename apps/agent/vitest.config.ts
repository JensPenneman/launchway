import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see the `@slipway/source` export condition).
const conditions = ['@slipway/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'agent',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
