import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/domains')({
  component: () => (
    <PlaceholderPage
      title="Domains"
      description="DNS zones, records and the domains Slipway serves."
      sections={['Zones', 'Records', 'Managed domains']}
    />
  ),
});
