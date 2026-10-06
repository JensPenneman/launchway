import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/apps/$appId')({ component: AppDetail });

function AppDetail() {
  const { appId } = Route.useParams();
  return (
    <PlaceholderPage
      title="App"
      description={appId}
      sections={['Deployments', 'Environment', 'Domains & routes', 'Settings', 'Danger zone']}
    />
  );
}
