import { defineConfig } from 'vitest/config';

const conditions = ['@launchway/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'agent:integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // Drives the real Docker daemon (docker CLI + Compose) and git.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
