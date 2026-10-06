import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/nodes/')({
  component: () => (
    <PlaceholderPage
      title="Nodes"
      description="Machines running the Slipway agent."
      sections={['Add node']}
    />
  ),
});
