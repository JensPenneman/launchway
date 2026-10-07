import { defineConfig } from 'vitest/config';

const conditions = ['@launchway/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'api:integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // Starts PostgreSQL (Testcontainers, or TEST_DATABASE_URL) and applies migrations once.
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
