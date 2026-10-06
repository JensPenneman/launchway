import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-sm underline underline-offset-4">
        Back to the overview
      </Link>
    </div>
  ),
});
