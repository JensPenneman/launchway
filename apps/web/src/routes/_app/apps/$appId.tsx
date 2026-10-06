import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { appQuery } from '@/api/apps';
import { isApiError } from '@/api/request';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { StatusBadge } from '@/components/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DangerZoneTab } from '@/features/apps/danger-zone-tab';
import { DeploymentsTab } from '@/features/apps/deployments-tab';
import { DomainsTab } from '@/features/apps/domains-tab';
import { EnvironmentTab } from '@/features/apps/environment-tab';
import { OverviewTab } from '@/features/apps/overview-tab';
import { SettingsTab } from '@/features/apps/settings-tab';
import { useCan } from '@/hooks/use-me';

const TABS = ['overview', 'deployments', 'environment', 'domains', 'settings', 'danger'] as const;
type AppTab = (typeof TABS)[number];

const TAB_LABELS: Record<AppTab, string> = {
  overview: 'Overview',
  deployments: 'Deployments',
  environment: 'Environment',
  domains: 'Domains & routes',
  settings: 'Settings',
  danger: 'Danger zone',
};

interface AppSearch {
  tab?: AppTab;
  deployment?: string;
}

export const Route = createFileRoute('/_app/apps/$appId')({
  validateSearch: (search: Record<string, unknown>): AppSearch => ({
    ...(TABS.includes(search.tab as AppTab) ? { tab: search.tab as AppTab } : {}),
    ...(typeof search.deployment === 'string' ? { deployment: search.deployment } : {}),
  }),
  component: AppDetail,
});

function AppDetail() {
  const { appId } = Route.useParams();
  const { tab = 'overview', deployment } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const app = useQuery(appQuery(appId));
  const canManage = useCan('member');
  const visibleTabs = TABS.filter(
    (name) => canManage || (name !== 'settings' && name !== 'danger'),
  );

  if (app.isPending) {
    return (
      <Page>
        <ListSkeleton rows={6} />
      </Page>
    );
  }
  if (app.isError) {
    return (
      <Page>
        {isApiError(app.error, 'not-found') ? (
          <EmptyState
            title="App not found"
            description="It may have been deleted."
            action={
              <Link to="/apps" className="text-sm underline underline-offset-4">
                Back to apps
              </Link>
            }
          />
        ) : (
          <ErrorAlert error={app.error} onRetry={() => void app.refetch()} />
        )}
      </Page>
    );
  }

  const data = app.data;
  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link to="/apps" className="hover:underline">
            Apps
          </Link>
        }
        title={data.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <a
              href={`https://github.com/${data.repository.owner}/${data.repository.name}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm hover:underline"
            >
              {data.repository.owner}/{data.repository.name}
            </a>
            {data.activeDeploymentId ? (
              <StatusBadge tone="success">running</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">not running</StatusBadge>
            )}
          </span>
        }
      />
      <Tabs
        value={visibleTabs.includes(tab) ? tab : 'overview'}
        onValueChange={(value) =>
          void navigate({ search: { tab: value as AppTab }, replace: true })
        }
      >
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            {visibleTabs.map((name) => (
              <TabsTrigger key={name} value={name}>
                {TAB_LABELS[name]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab app={data} />
        </TabsContent>
        <TabsContent value="deployments" className="mt-4">
          <DeploymentsTab
            app={data}
            openDeploymentId={deployment ?? null}
            onOpenDeployment={(id) =>
              void navigate({
                search: id ? { tab: 'deployments', deployment: id } : { tab: 'deployments' },
              })
            }
          />
        </TabsContent>
        <TabsContent value="environment" className="mt-4">
          <EnvironmentTab app={data} />
        </TabsContent>
        <TabsContent value="domains" className="mt-4">
          <DomainsTab app={data} />
        </TabsContent>
        {canManage && (
          <>
            <TabsContent value="settings" className="mt-4">
              <SettingsTab app={data} />
            </TabsContent>
            <TabsContent value="danger" className="mt-4">
              <DangerZoneTab app={data} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </Page>
  );
}
