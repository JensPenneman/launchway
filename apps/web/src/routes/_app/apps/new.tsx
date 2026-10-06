import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/apps/new')({
  component: () => (
    <PlaceholderPage
      title="New app"
      description="Connect a repository and choose where it runs."
      sections={['Connection', 'Repository', 'Compose location', 'Node']}
    />
  ),
});
