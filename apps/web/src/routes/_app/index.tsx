import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { livenessQuery } from '@/lib/api/queries';

export const Route = createFileRoute('/_app/')({ component: Overview });

function Overview() {
  const liveness = useQuery(livenessQuery);
  const status = liveness.isPending
    ? 'Checking...'
    : liveness.data
      ? `Online, version ${liveness.data.version}`
      : 'Unreachable';
  return (
    <PlaceholderPage
      title="Overview"
      description="Apps, deployments and nodes at a glance."
      sections={['Recent deployments', 'Nodes']}
    >
      <Card>
        <CardHeader>
          <CardTitle>Control plane</CardTitle>
          <CardDescription data-testid="api-status">{status}</CardDescription>
        </CardHeader>
      </Card>
    </PlaceholderPage>
  );
}
