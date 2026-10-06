import { type App, GitRef, isInProgressStatus } from '@slipway/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Loader2, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  cancelDeployment,
  createDeployment,
  deploymentLogsUrl,
  deploymentQuery,
  deploymentsQuery,
} from '@/api/apps';
import { useDeploymentLogStream } from '@/api/events';
import { releasesQuery } from '@/api/github';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { LogViewer, type LogViewerLine } from '@/components/log-viewer';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { RadioCard, RadioCardGroup } from '@/components/radio-card';
import { DeploymentStatusBadge, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/hooks/use-me';
import { fieldError } from '@/lib/form';
import { formatDateTime, formatDuration, formatRelative, shortSha } from '@/lib/format';
import { cn } from '@/lib/utils';

interface DeploymentsTabProps {
  app: App;
  openDeploymentId: string | null;
  onOpenDeployment: (id: string | null) => void;
}

export function DeploymentsTab({ app, openDeploymentId, onOpenDeployment }: DeploymentsTabProps) {
  const canDeploy = useCan('member');
  const deployments = useInfiniteQuery(deploymentsQuery(app.id));
  const cancel = useApiMutation(cancelDeployment, {
    invalidate: [keys.deployments],
    success: 'Cancellation requested',
  });
  const items = deployments.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Every deployment builds and starts one ref. Redeploy an older release to roll back.
        </p>
        {canDeploy && <DeployDialog app={app} onDeployed={(id) => onOpenDeployment(id)} />}
      </div>
      {deployments.isPending ? (
        <ListSkeleton rows={5} />
      ) : deployments.isError ? (
        <ErrorAlert error={deployments.error} onRetry={() => void deployments.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="No deployments yet"
          description="Deploy a release, branch or commit of the repository."
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead className="hidden sm:table-cell">Commit</TableHead>
                <TableHead className="hidden md:table-cell">Trigger</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="hidden lg:table-cell">Duration</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((deployment) => (
                <TableRow
                  key={deployment.id}
                  className={cn(deployment.id === app.activeDeploymentId && 'bg-emerald-500/5')}
                >
                  <TableCell>
                    <DeploymentStatusBadge status={deployment.status} />
                  </TableCell>
                  <TableCell className="font-mono text-sm">{deployment.ref}</TableCell>
                  <TableCell className="hidden font-mono text-xs sm:table-cell">
                    {shortSha(deployment.commitSha)}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{deployment.trigger}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatRelative(deployment.createdAt)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {formatDuration(deployment.startedAt, deployment.finishedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {canDeploy && isInProgressStatus(deployment.status) && (
                        <ConfirmButton
                          title="Cancel this deployment?"
                          description={`The deployment of ${deployment.ref} stops; the running release stays up.`}
                          confirmLabel="Cancel deployment"
                          onConfirm={() => cancel.mutate(deployment.id)}
                        >
                          <Button variant="ghost" size="sm">
                            <Ban /> Cancel
                          </Button>
                        </ConfirmButton>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenDeployment(deployment.id)}
                      >
                        Logs
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {deployments.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void deployments.fetchNextPage()}
          disabled={deployments.isFetchingNextPage}
        >
          {deployments.isFetchingNextPage && <Loader2 className="animate-spin" />}
          Load more
        </Button>
      )}
      <DeploymentDrawer
        deploymentId={openDeploymentId}
        app={app}
        onClose={() => onOpenDeployment(null)}
      />
    </div>
  );
}

function DeployDialog({ app, onDeployed }: { app: App; onDeployed: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'release' | 'ref'>('release');
  const [ref, setRef] = useState('');
  const [selected, setSelected] = useState('');
  const releases = useQuery({
    ...releasesQuery(app.connectionId, app.repository.owner, app.repository.name),
    enabled: open,
  });
  const deploy = useApiMutation((value: string) => createDeployment(app.id, { ref: value }), {
    invalidate: [keys.deployments, keys.apps],
    success: (deployment) => `Deploying ${deployment.ref}`,
    onSuccess: (deployment) => {
      setOpen(false);
      onDeployed(deployment.id);
    },
  });
  const value = mode === 'release' ? selected : ref.trim();
  const refError = mode === 'ref' && value !== '' ? fieldError(GitRef, value) : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Rocket /> Deploy
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deploy {app.name}</DialogTitle>
          <DialogDescription>Pick a release, or enter a branch, tag or commit.</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(next) => setMode(next as 'release' | 'ref')}>
          <TabsList>
            <TabsTrigger value="release">Release</TabsTrigger>
            <TabsTrigger value="ref">Branch, tag or commit</TabsTrigger>
          </TabsList>
          <TabsContent value="release" className="mt-3">
            {releases.isPending ? (
              <ListSkeleton rows={3} />
            ) : releases.isError ? (
              <ErrorAlert error={releases.error} />
            ) : releases.data.items.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">This repository has no releases.</p>
            ) : (
              <RadioCardGroup legend="Release" className="max-h-72 gap-1 overflow-y-auto p-0.5">
                {releases.data.items
                  .filter((release) => !release.draft)
                  .map((release) => (
                    <RadioCard
                      key={release.id}
                      name="release"
                      value={release.tagName}
                      checked={selected === release.tagName}
                      onSelect={() => setSelected(release.tagName)}
                      className="px-3 py-2 text-sm"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-mono">{release.tagName}</span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {release.prerelease && (
                            <StatusBadge tone="warning">prerelease</StatusBadge>
                          )}
                          {formatRelative(release.publishedAt)}
                        </span>
                      </span>
                    </RadioCard>
                  ))}
              </RadioCardGroup>
            )}
          </TabsContent>
          <TabsContent value="ref" className="mt-3">
            <Field
              label="Ref"
              error={refError}
              description="Resolved to a commit when the deployment is created."
            >
              <Input
                className="font-mono"
                placeholder="main"
                value={ref}
                onChange={(event) => setRef(event.target.value)}
              />
            </Field>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button
            onClick={() => deploy.mutate(value)}
            disabled={value === '' || refError !== undefined || deploy.isPending}
          >
            {deploy.isPending && <Loader2 className="animate-spin" />}
            Deploy {value || ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeploymentDrawer({
  deploymentId,
  app,
  onClose,
}: {
  deploymentId: string | null;
  app: App;
  onClose: () => void;
}) {
  return (
    <Sheet open={deploymentId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        {deploymentId && <DeploymentDetail deploymentId={deploymentId} app={app} />}
      </SheetContent>
    </Sheet>
  );
}

function DeploymentDetail({ deploymentId, app }: { deploymentId: string; app: App }) {
  const queryClient = useQueryClient();
  const canDeploy = useCan('member');
  const deployment = useQuery(deploymentQuery(deploymentId));
  const stream = useDeploymentLogStream(deploymentLogsUrl(deploymentId));
  const cancel = useApiMutation(() => cancelDeployment(deploymentId), {
    invalidate: [keys.deployments],
    success: 'Cancellation requested',
  });

  // Status changes in the stream refresh the deployment and the app (active deployment).
  useEffect(() => {
    if (stream.status || stream.state === 'ended') {
      void queryClient.invalidateQueries({ queryKey: keys.deployments });
      void queryClient.invalidateQueries({ queryKey: keys.apps });
    }
  }, [stream.status, stream.state, queryClient]);

  const status = stream.status ?? deployment.data?.status;
  const lines: LogViewerLine[] = stream.lines.map((line) => ({
    key: line.seq,
    text: line.line,
    tone: line.stream === 'stderr' ? 'error' : line.stream === 'system' ? 'system' : 'default',
  }));

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle className="flex items-center gap-2">
          Deployment <span className="font-mono">{deployment.data?.ref ?? ''}</span>
          {status && <DeploymentStatusBadge status={status} />}
        </SheetTitle>
        <SheetDescription>
          {deployment.data
            ? `${shortSha(deployment.data.commitSha)} · ${deployment.data.trigger} · created ${formatDateTime(deployment.data.createdAt)}`
            : 'Loading…'}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {deployment.isError && <ErrorAlert error={deployment.error} />}
        {deployment.data?.statusMessage && (
          <p
            className={cn(
              'rounded-lg border p-3 text-sm',
              status === 'failed' && 'border-destructive/40 text-destructive',
            )}
          >
            {deployment.data.statusMessage}
          </p>
        )}
        {deployment.data && deployment.data.services.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {deployment.data.services.map((service) => (
              <span key={service.service} className="rounded-md border px-2 py-1 font-mono">
                {service.service}: {service.state}
                {service.health ? ` (${service.health})` : ''}
              </span>
            ))}
          </div>
        )}
        <LogViewer
          lines={lines}
          state={stream.state}
          filename={`${app.slug}-${deployment.data?.ref ?? deploymentId}.log`}
          className="min-h-80 flex-1"
        />
        {canDeploy && status && isInProgressStatus(status) && (
          <Button
            variant="destructive"
            className="self-start"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
            <Ban /> Cancel deployment
          </Button>
        )}
      </div>
    </>
  );
}
