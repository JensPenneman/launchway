import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Boxes, Plus } from 'lucide-react';
import { appsQuery } from '@/api/apps';
import { nodesQuery } from '@/api/nodes';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCan } from '@/hooks/use-me';
import { formatRelative } from '@/lib/format';

export const Route = createFileRoute('/_app/apps/')({ component: AppList });

function AppList() {
  const apps = useQuery(appsQuery);
  const nodes = useQuery(nodesQuery);
  const canCreate = useCan('member');
  const nodeNames = new Map((nodes.data?.items ?? []).map((node) => [node.id, node.name]));

  const newButton = canCreate && (
    <Button asChild>
      <Link to="/apps/new">
        <Plus /> New app
      </Link>
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="Apps"
        description="Repositories Launchway builds and runs."
        actions={newButton}
      />
      {apps.isPending ? (
        <ListSkeleton rows={5} />
      ) : apps.isError ? (
        <ErrorAlert error={apps.error} onRetry={() => void apps.refetch()} />
      ) : apps.data.items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No apps yet"
          description="An app is a GitHub repository with a Compose file or a Dockerfile. Pick a release and Launchway runs it on one of your nodes."
          action={newButton}
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Repository</TableHead>
                <TableHead className="hidden sm:table-cell">Node</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.data.items.map((app) => (
                <TableRow key={app.id}>
                  <TableCell>
                    <Link
                      to="/apps/$appId"
                      params={{ appId: app.id }}
                      className="font-medium hover:underline"
                    >
                      {app.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{app.slug}</div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">
                    {app.repository.owner}/{app.repository.name}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {nodeNames.get(app.nodeId) ?? '—'}
                  </TableCell>
                  <TableCell>
                    {app.activeDeploymentId ? (
                      <StatusBadge tone="success">running</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">not running</StatusBadge>
                    )}
                    {app.autoDeployReleases && (
                      <span className="ml-2 text-xs text-muted-foreground">auto-deploy</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {formatRelative(app.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
}
