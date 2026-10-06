import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Where the API sends the browser after the GitHub App manifest and installation callbacks
 * (`/settings/github?connection=<id>`): the GitHub tab of the settings page.
 */
export const Route = createFileRoute('/_app/settings_/github')({
  beforeLoad: () => {
    throw redirect({ to: '/settings', search: { tab: 'github' }, replace: true });
  },
});
