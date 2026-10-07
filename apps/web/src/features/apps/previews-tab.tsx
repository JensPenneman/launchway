import { type App, type Preview, PrNumber } from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitPullRequest, Loader2, RotateCw, X } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { appPreviewsQuery, closePreview, createPreview, redeployPreview } from '@/api/previews';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { DeploymentStatusBadge, PreviewStatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

interface PreviewsTabProps {
  app: App;
  /** Opens a deployment in the deployments tab (its logs). */
  onOpenDeployment: (id: string) => void;
}

/** Pull request previews of an app: one running copy per pull request at its own host name. */
export function PreviewsTab({ app, onOpenDeployment }: PreviewsTabProps) {
  const canManage = useCan('member');
  const previews = useQuery(appPreviewsQuery(app.id));
  const items = previews.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Every pull request from a branch of {app.repository.owner}/{app.repository.name} gets its
          own copy of the app; each push updates it and closing the pull request removes it.
        </p>
        {canManage && app.previews.enabled && <OpenPreviewForm appId={app.id} />}
      </div>
      {!app.previews.enabled && (
        <Alert>
          <GitPullRequest />
          <AlertDescription>
            Previews are off for this app. Turn them on in the app settings; the platform needs a
            preview base domain too.
          </AlertDescription>
        </Alert>
      )}
      {previews.isPending ? (
        <ListSkeleton rows={3} />
      ) : previews.isError ? (
        <ErrorAlert error={previews.error} onRetry={() => void previews.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No previews yet"
          description="Open a pull request, or open the preview of an existing one by its number."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pull request</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Address</TableHead>
                <TableHead className="hidden sm:table-cell">Last deployment</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((preview) => (
                <PreviewRow
                  key={preview.id}
                  app={app}
                  preview={preview}
                  canManage={canManage}
                  onOpenDeployment={onOpenDeployment}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function PreviewRow({
  app,
  preview,
  canManage,
  onOpenDeployment,
}: {
  app: App;
  preview: Preview;
  canManage: boolean;
  onOpenDeployment: (id: string) => void;
}) {
  const redeploy = useApiMutation(() => redeployPreview(preview.id), {
    invalidate: [keys.previews, keys.deployments],
    success: `Redeploying preview #${preview.prNumber}`,
  });
  const close = useApiMutation(() => closePreview(preview.id), {
    invalidate: [keys.previews, keys.domains, keys.routes],
    success: (result) =>
      result.status === 'closed'
        ? `Preview #${preview.prNumber} removed`
        : `Removing preview #${preview.prNumber}; it finishes once the node is back`,
  });
  const open = preview.status !== 'closed' && preview.status !== 'closing';
  const pullUrl = `https://github.com/${app.repository.owner}/${app.repository.name}/pull/${preview.prNumber}`;

  return (
    <TableRow>
      <TableCell className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <a
            href={pullUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate font-medium hover:underline"
          >
            #{preview.prNumber} {preview.prTitle}
          </a>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {preview.branch} · {shortSha(preview.headSha)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <PreviewStatusBadge status={preview.status} />
          {preview.statusMessage && (
            <span className="max-w-56 text-xs text-muted-foreground">{preview.statusMessage}</span>
          )}
          {preview.status === 'closed' && preview.closedAt && (
            <span className="text-xs text-muted-foreground">
              closed {formatRelative(preview.closedAt)}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {open ? (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-sm hover:underline"
          >
            {preview.hostname}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : (
          <span className="font-mono text-sm text-muted-foreground">{preview.hostname}</span>
        )}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {preview.lastDeployment ? (
          <button
            type="button"
            className="inline-flex items-center gap-2 text-left hover:underline"
            onClick={() => preview.lastDeployment && onOpenDeployment(preview.lastDeployment.id)}
          >
            <DeploymentStatusBadge status={preview.lastDeployment.status} />
            <span className="font-mono text-xs">{shortSha(preview.lastDeployment.commitSha)}</span>
          </button>
        ) : (
          <span className="text-sm text-muted-foreground">none</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {canManage && open && (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={redeploy.isPending}
              onClick={() => redeploy.mutate()}
            >
              {redeploy.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
              Redeploy
            </Button>
            <ConfirmButton
              title={`Close preview #${preview.prNumber}?`}
              description={
                <>
                  Removes <span className="font-mono">{preview.hostname}</span>, its DNS record and
                  the preview's containers with their volumes. Pushing to the pull request again
                  does not bring it back; reopen the pull request or open the preview here.
                </>
              }
              confirmLabel="Close preview"
              onConfirm={() => close.mutate()}
            >
              <Button variant="ghost" size="sm" disabled={close.isPending}>
                {close.isPending ? <Loader2 className="animate-spin" /> : <X />}
                Close
              </Button>
            </ConfirmButton>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function OpenPreviewForm({ appId }: { appId: string }) {
  const [value, setValue] = useState('');
  const parsed = PrNumber.safeParse(Number(value));
  const valid = value.trim() !== '' && parsed.success;
  const open = useApiMutation(() => createPreview(appId, { prNumber: Number(value) }), {
    invalidate: [keys.previews, keys.deployments],
    success: (preview) => `Preview #${preview.prNumber} is deploying`,
    onSuccess: () => setValue(''),
  });
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) open.mutate();
      }}
    >
      <Input
        aria-label="Pull request number"
        inputMode="numeric"
        placeholder="PR number"
        className="w-32"
        value={value}
        onChange={(event) => setValue(event.target.value.replace(/[^0-9]/g, ''))}
      />
      <Button type="submit" disabled={!valid || open.isPending}>
        {open.isPending ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
        Open preview
      </Button>
    </form>
  );
}
