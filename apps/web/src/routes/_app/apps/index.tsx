import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/apps/')({
  component: () => (
    <PlaceholderPage title="Apps" description="Deployable apps linked to GitHub repositories." />
  ),
});
