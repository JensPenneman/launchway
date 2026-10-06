import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '@/components/placeholder-page';

export const Route = createFileRoute('/_app/nodes/$nodeId')({ component: NodeDetail });

function NodeDetail() {
  const { nodeId } = Route.useParams();
  return (
    <PlaceholderPage
      title="Node"
      description={nodeId}
      sections={['Docker', 'Apps', 'Credentials']}
    />
  );
}
