import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Workspace packages resolve to their TypeScript sources (`@slipway/source` export condition).
    conditions: ['@slipway/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same origin as in production: the UI calls /api on the API server.
    proxy: { '/api': { target: 'http://localhost:3000' } },
  },
  preview: { port: 4173, strictPort: true },
  build: { sourcemap: true },
});
