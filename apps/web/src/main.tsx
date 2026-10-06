import '@/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { keys } from '@/api/keys';
import { ApiError, setUnauthorizedHandler } from '@/api/request';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routeTree } from './routeTree.gen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Client errors (4xx) do not get better by retrying.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// A request answered 401 mid-session (expired or revoked session): back to the sign-in page.
setUnauthorizedHandler(() => {
  const { pathname, href } = router.state.location;
  if (pathname === '/sign-in') return;
  queryClient.removeQueries({ queryKey: keys.me });
  void router.navigate({ to: '/sign-in', search: { redirect: href } });
});

async function enableMocking(): Promise<void> {
  if (import.meta.env.VITE_API_MOCK !== '1') return;
  const { startMockApi } = await import('./mocks/browser');
  await startMockApi();
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

void enableMocking().then(() => {
  createRoot(container).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
          <Toaster closeButton />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
});
