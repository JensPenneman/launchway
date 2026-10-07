import { fileURLToPath } from 'node:url';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Workspace packages resolve to their TypeScript sources, as in Vite.
    conditions: ['@launchway/source', ...defaultClientConditions],
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
