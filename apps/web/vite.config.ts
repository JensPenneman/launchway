import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const WORKER_FILE = 'mockServiceWorker.js';

/**
 * With `VITE_API_MOCK=1` the UI talks to MSW instead of the API (demos, e2e tests). This serves
 * MSW's service worker in dev and emits it into the build; normal builds do not contain it.
 */
function mockServiceWorker(enabled: boolean): Plugin {
  const source = () => readFileSync(require.resolve(`msw/${WORKER_FILE}`), 'utf8');
  return {
    name: 'slipway:mock-service-worker',
    apply: () => enabled,
    configureServer(server) {
      server.middlewares.use(`/${WORKER_FILE}`, (_request, response) => {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: WORKER_FILE, source: source() });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  return {
    plugins: [
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      mockServiceWorker(env.VITE_API_MOCK === '1'),
    ],
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
  };
});
