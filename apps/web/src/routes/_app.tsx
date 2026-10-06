import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { meQuery, setupStatusQuery } from '@/api/auth';
import { isApiError } from '@/api/request';
import { AppShell } from '@/components/app-shell';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const setup = await context.queryClient.ensureQueryData(setupStatusQuery).catch(() => null);
    if (setup?.setupRequired) throw redirect({ to: '/setup' });
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (isApiError(error, 'unauthorized')) {
        throw redirect({ to: '/sign-in', search: { redirect: location.href } });
      }
      throw error;
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
