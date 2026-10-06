import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** Serves the API from MSW (`VITE_API_MOCK=1`); the worker script is served by the Vite plugin. */
export async function startMockApi(): Promise<void> {
  const worker = setupWorker(...handlers);
  await worker.start({
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
    onUnhandledRequest: (request, print) => {
      if (new URL(request.url).pathname.startsWith('/api/')) print.warning();
    },
  });
}
