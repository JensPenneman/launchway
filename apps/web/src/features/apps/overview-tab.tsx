import type { App } from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Rocket, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { appLogsUrl, appStatusQuery, createDeployment, deploymentQuery } from '@/api/apps';
import { useAppLogStream } from '@/api/events';
import { releasesQuery } from '@/api/github';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodeQuery } from '@/api/nodes';
import { LogViewer, type LogViewerLine } from '@/components/log-viewer';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { DeploymentStatusBadge, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCan } from '@/hooks/use-me';
import { formatRelative, shortSha } from '@/lib/format';
import { latestRelease } from './release-utils';

export function OverviewTab({ app }: { app: App }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <RunningDeploymentCard app={app} />
      <QuickDeployCard app={app} />
      <ServicesCard app={app} />
      <ContainerLogsCard app={app} />
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function RunningDeploymentCard({ app }: { app: App }) {
  const active = useQuery({
    ...deploymentQuery(app.activeDeploymentId ?? ''),
    enabled: app.activeDeploymentId !== null,
  });
  const node = useQuery(nodeQuery(app.nodeId));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Running deployment</CardTitle>
        <CardDescription>
          On {node.data?.name ?? 'its node'}
          {app.composeFiles
            ? ` · ${app.composeFiles.join(', ')}`
            : ` · ${app.dockerfile ?? 'Dockerfile'}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {app.activeDeploymentId === null ? (
          <p className="text-sm text-muted-foreground">
            Nothing is running. Deploy a release to start the app.
          </p>
        ) : active.isPending ? (
          <ListSkeleton rows={3} />
        ) : active.isError ? (
          <ErrorAlert error={active.error} />
        ) : (
          <dl className="divide-y">
            <Detail label="Release">
              <span className="font-mono">{active.data.ref}</span>
            </Detail>
            <Detail label="Commit">
              <span className="font-mono">{shortSha(active.data.commitSha)}</span>
            </Detail>
            <Detail label="Status">
              <DeploymentStatusBadge status={active.data.status} />
            </Detail>
            <Detail label="Started">{formatRelative(active.data.startedAt)}</Detail>
            <Detail label="Trigger">{active.data.trigger}</Detail>
            <div className="pt-2">
              <Link
                to="/apps/$appId"
                params={{ appId: app.id }}
                search={{ tab: 'deployments', deployment: active.data.id }}
                className="text-sm underline underline-offset-4"
              >
                View deployment log
              </Link>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function QuickDeployCard({ app }: { app: App }) {
  const canDeploy = useCan('member');
  const releases = useQuery(
    releasesQuery(app.connectionId, app.repository.owner, app.repository.name),
  );
  const deploy = useApiMutation((ref: string) => createDeployment(app.id, { ref }), {
    invalidate: [keys.deployments, keys.apps],
    success: (deployment) => `Deploying ${deployment.ref}`,
  });
  const active = useQuery({
    ...deploymentQuery(app.activeDeploymentId ?? ''),
    enabled: app.activeDeploymentId !== null,
  });
  const latest = latestRelease(releases.data?.items ?? []);
  const isRunning = latest !== undefined && active.data?.ref === latest.tagName;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest release</CardTitle>
        <CardDescription>From GitHub releases of the repository.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {releases.isPending ? (
          <ListSkeleton rows={2} />
        ) : releases.isError ? (
          <ErrorAlert error={releases.error} />
        ) : !latest ? (
          <p className="text-sm text-muted-foreground">
            The repository has no releases yet. You can still deploy a branch or commit from the
            Deployments tab.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <a
                  href={latest.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono font-medium hover:underline"
                >
                  {latest.tagName}
                </a>
                <p className="truncate text-xs text-muted-foreground">
                  {latest.name && latest.name !== latest.tagName ? `${latest.name} · ` : ''}
                  published {formatRelative(latest.publishedAt)}
                </p>
              </div>
              {latest.prerelease && <StatusBadge tone="warning">prerelease</StatusBadge>}
            </div>
            {isRunning && <p className="text-sm text-muted-foreground">This release is running.</p>}
            {canDeploy && (
              <Button
                variant={isRunning ? 'outline' : 'default'}
                onClick={() => deploy.mutate(latest.tagName)}
                disabled={deploy.isPending}
                className="self-start"
              >
                <Rocket /> {isRunning ? 'Redeploy' : 'Deploy'} {latest.tagName}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ServicesCard({ app }: { app: App }) {
  const status = useQuery({ ...appStatusQuery(app.id), enabled: app.activeDeploymentId !== null });
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Services</CardTitle>
        <CardDescription>Containers of the running deployment.</CardDescription>
      </CardHeader>
      <CardContent>
        {app.activeDeploymentId === null ? (
          <p className="text-sm text-muted-foreground">No containers are running.</p>
        ) : status.isPending ? (
          <ListSkeleton rows={2} />
        ) : status.isError ? (
          <ErrorAlert error={status.error} />
        ) : status.data.services.length === 0 ? (
          <p className="text-sm text-muted-foreground">No services reported yet.</p>
        ) : (
          <>
            {status.data.source === 'last-deployment' && (
              <p className="mb-2 text-sm text-amber-700 dark:text-amber-300">
                The node is offline; this is the last state it reported.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Published ports</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.data.services.map((service) => (
                  <TableRow key={service.service}>
                    <TableCell className="font-mono">{service.service}</TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={
                          service.state === 'running'
                            ? 'success'
                            : service.state === 'restarting'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {service.state}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      {service.health ? (
                        <StatusBadge
                          tone={
                            service.health === 'healthy'
                              ? 'success'
                              : service.health === 'starting'
                                ? 'info'
                                : 'danger'
                          }
                        >
                          {service.health}
                        </StatusBadge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {service.publishedPorts.length === 0
                        ? '—'
                        : service.publishedPorts
                            .map(
                              (port) => `${port.hostPort}→${port.containerPort}/${port.protocol}`,
                            )
                            .join(', ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const ALL_SERVICES = '__all__';

function ContainerLogsCard({ app }: { app: App }) {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState(ALL_SERVICES);
  const status = useQuery({ ...appStatusQuery(app.id), enabled: app.activeDeploymentId !== null });
  const url = open ? appLogsUrl(app.id, service === ALL_SERVICES ? undefined : service) : null;
  const stream = useAppLogStream(url);
  const lines: LogViewerLine[] = stream.lines.map((line, index) => ({
    key: `${line.timestamp}-${index}`,
    prefix: line.service,
    text: line.line,
    tone: line.stream === 'stderr' ? 'error' : 'default',
  }));
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Container logs</CardTitle>
        <CardDescription>Live output of the running containers.</CardDescription>
        <CardAction className="flex items-center gap-2">
          {open && (
            <Select value={service} onValueChange={setService}>
              <SelectTrigger size="sm" aria-label="Service" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SERVICES}>All services</SelectItem>
                {(status.data?.services ?? []).map((item) => (
                  <SelectItem key={item.service} value={item.service}>
                    {item.service}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
            <ScrollText /> {open ? 'Stop' : 'Show logs'}
          </Button>
        </CardAction>
      </CardHeader>
      {open && (
        <CardContent>
          <LogViewer
            lines={lines}
            state={stream.state}
            filename={`${app.slug}-logs.txt`}
            className="h-80"
          />
        </CardContent>
      )}
    </Card>
  );
}
