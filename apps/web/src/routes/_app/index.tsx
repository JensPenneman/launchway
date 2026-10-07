import type { App, Deployment } from '@launchway/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Boxes, Globe, type LucideIcon, Rocket, Server } from 'lucide-react';
import { appsQuery, recentDeploymentsQuery } from '@/api/apps';
import { domainsQuery } from '@/api/domains';
import { nodesQuery } from '@/api/nodes';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import {
  DeploymentStatusBadge,
  DomainStatusBadge,
  NodeStatusBadge,
} from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/hooks/use-me';
import { isDomainServing } from '@/lib/domains';
import { formatRelative, shortSha } from '@/lib/format';

export const Route = createFileRoute('/_app/')({ component: Overview });

/** Apps whose recent deployments are loaded for the overview. */
const OVERVIEW_APP_LIMIT = 12;

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  to,
}: {
  icon: LucideIcon;
  label: string;
  value: string | undefined;
  hint: string;
  to: '/apps' | '/nodes' | '/domains';
}) {
  return (
    <Link
      to={to}
      className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="h-full transition-colors hover:bg-muted/40">
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <Icon className="size-4" aria-hidden="true" /> {label}
          </CardDescription>
          <CardTitle className="text-2xl tabular-nums" data-testid={`stat-${label.toLowerCase()}`}>
            {value ?? <Skeleton className="h-7 w-16" />}
          </CardTitle>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardHeader>
      </Card>
    </Link>
  );
}

function Overview() {
  const apps = useQuery(appsQuery);
  const nodes = useQuery(nodesQuery);
  const domains = useQuery(domainsQuery);
  const canDeploy = useCan('member');

  const appList = apps.data?.items ?? [];
  const deploymentQueries = useQueries({
    queries: appList.slice(0, OVERVIEW_APP_LIMIT).map((app) => recentDeploymentsQuery(app.id, 5)),
  });
  const deploymentsByApp = new Map<string, Deployment[]>();
  appList.slice(0, OVERVIEW_APP_LIMIT).forEach((app, index) => {
    deploymentsByApp.set(app.id, deploymentQueries[index]?.data?.items ?? []);
  });
  const recent = [...deploymentsByApp.values()]
    .flat()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);
  const appNames = new Map(appList.map((app) => [app.id, app.name]));

  const nodeItems = nodes.data?.items ?? [];
  const online = nodeItems.filter((node) => node.status === 'online').length;
  const problems = (domains.data?.items ?? []).filter((domain) => !isDomainServing(domain.status));
  const running = appList.filter((app) => app.activeDeploymentId !== null).length;

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Apps, deployments, nodes and domains at a glance."
        actions={
          canDeploy && (
            <Button asChild>
              <Link to="/apps/new">
                <Rocket /> New app
              </Link>
            </Button>
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          icon={Server}
          label="Nodes"
          value={nodes.data ? `${online}/${nodeItems.length}` : undefined}
          hint="online"
          to="/nodes"
        />
        <Stat
          icon={Boxes}
          label="Apps"
          value={apps.data ? `${running}/${appList.length}` : undefined}
          hint="running"
          to="/apps"
        />
        <Stat
          icon={Globe}
          label="Domains"
          value={domains.data ? String(problems.length) : undefined}
          hint={problems.length === 1 ? 'needs attention' : 'need attention'}
          to="/domains"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Apps</CardTitle>
            <CardDescription>The release each app is running.</CardDescription>
          </CardHeader>
          <CardContent>
            {apps.isPending ? (
              <ListSkeleton rows={3} />
            ) : apps.isError ? (
              <ErrorAlert error={apps.error} onRetry={() => void apps.refetch()} />
            ) : appList.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No apps yet"
                description="Link a GitHub repository and deploy one of its releases."
                action={
                  canDeploy && (
                    <Button asChild size="sm">
                      <Link to="/apps/new">Create an app</Link>
                    </Button>
                  )
                }
              />
            ) : (
              <ul className="divide-y">
                {appList.slice(0, OVERVIEW_APP_LIMIT).map((app) => (
                  <AppRow key={app.id} app={app} deployments={deploymentsByApp.get(app.id) ?? []} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Nodes</CardTitle>
          </CardHeader>
          <CardContent>
            {nodes.isPending ? (
              <ListSkeleton rows={2} />
            ) : nodes.isError ? (
              <ErrorAlert error={nodes.error} />
            ) : nodeItems.length === 0 ? (
              <EmptyState icon={Server} title="No nodes" description="Add a node to run apps." />
            ) : (
              <ul className="divide-y">
                {nodeItems.map((node) => (
                  <li key={node.id} className="flex items-center justify-between gap-2 py-2">
                    <Link
                      to="/nodes/$nodeId"
                      params={{ nodeId: node.id }}
                      className="truncate font-medium hover:underline"
                    >
                      {node.name}
                      {node.isEdge && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">edge</span>
                      )}
                    </Link>
                    <NodeStatusBadge status={node.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Recent deployments</CardTitle>
          </CardHeader>
          <CardContent>
            {apps.isPending ? (
              <ListSkeleton rows={3} />
            ) : recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deployments yet.</p>
            ) : (
              <ul className="divide-y" aria-label="Recent deployments">
                {recent.map((deployment) => (
                  <li key={deployment.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link
                        to="/apps/$appId"
                        params={{ appId: deployment.appId }}
                        search={{ tab: 'deployments', deployment: deployment.id }}
                        className="font-medium hover:underline"
                      >
                        {appNames.get(deployment.appId) ?? deployment.appId}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {deployment.ref} · {shortSha(deployment.commitSha)} ·{' '}
                        {formatRelative(deployment.createdAt)}
                      </p>
                    </div>
                    <DeploymentStatusBadge status={deployment.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Domains with problems</CardTitle>
          </CardHeader>
          <CardContent>
            {domains.isPending ? (
              <ListSkeleton rows={2} />
            ) : domains.isError ? (
              <ErrorAlert error={domains.error} />
            ) : problems.length === 0 ? (
              <p className="text-sm text-muted-foreground">All domains pass the DNS preflight.</p>
            ) : (
              <ul className="divide-y">
                {problems.map((domain) => (
                  <li key={domain.id} className="flex flex-col gap-1 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-sm">{domain.hostname}</span>
                      <DomainStatusBadge status={domain.status} />
                    </div>
                    {domain.statusMessage && (
                      <p className="text-xs text-muted-foreground">{domain.statusMessage}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function AppRow({ app, deployments }: { app: App; deployments: Deployment[] }) {
  const active = deployments.find((deployment) => deployment.id === app.activeDeploymentId);
  const latest = deployments[0];
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <Link to="/apps/$appId" params={{ appId: app.id }} className="font-medium hover:underline">
          {app.name}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {app.repository.owner}/{app.repository.name}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-sm">
        {active ? (
          <span className="font-mono text-xs" title={active.commitSha}>
            {active.ref}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">not running</span>
        )}
        {latest && latest.id !== active?.id && <DeploymentStatusBadge status={latest.status} />}
        {active && latest?.id === active.id && <DeploymentStatusBadge status={active.status} />}
      </div>
    </li>
  );
}
