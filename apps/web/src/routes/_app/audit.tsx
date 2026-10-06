import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/audit')({
  component: () => (
    <PlaceholderPage title="Audit log" description="Who changed what, when and from where." />
  ),
});
