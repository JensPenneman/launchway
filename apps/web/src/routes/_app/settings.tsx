import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/settings')({
  component: () => (
    <PlaceholderPage
      title="Settings"
      description="Your account and the platform configuration."
      sections={[
        'Account',
        'Passkeys',
        'API tokens',
        'Users & invitations',
        'GitHub connections',
        'DNS provider accounts',
        'Platform settings',
      ]}
    />
  ),
});
