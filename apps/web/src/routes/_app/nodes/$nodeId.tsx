import type { Node, NodeJoinToken } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Ban, KeyRound, Loader2, Pencil, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { appsQuery } from '@/api/apps';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import {
  createJoinToken,
  deleteNode,
  nodeQuery,
  renameNode,
  revokeCredential,
  rotateCredential,
} from '@/api/nodes';
import { updateSettings } from '@/api/platform';
import { isApiError } from '@/api/request';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { NodeStatusBadge, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { JoinInstructions } from '@/features/nodes/join-instructions';
import { useCan } from '@/hooks/use-me';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';

export const Route = createFileRoute('/_app/nodes/$nodeId')({ component: NodeDetail });

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

function NodeDetail() {
  const { nodeId } = Route.useParams();
  const node = useQuery(nodeQuery(nodeId));
  const apps = useQuery(appsQuery);
  const isAdmin = useCan('admin');
  const navigate = useNavigate();
  const remove = useApiMutation(() => deleteNode(nodeId), {
    invalidate: [keys.nodes],
    success: 'Node removed',
    onSuccess: () => void navigate({ to: '/nodes' }),
  });
  const rotate = useApiMutation(() => rotateCredential(nodeId), {
    invalidate: [keys.nodes],
    success: 'New credential delivered to the agent',
  });
  const revoke = useApiMutation(() => revokeCredential(nodeId), {
    invalidate: [keys.nodes],
    success: 'Credential revoked; the agent is disconnected',
  });
  const makeEdge = useApiMutation(() => updateSettings({ edgeNodeId: nodeId as Node['id'] }), {
    invalidate: [keys.nodes, keys.settings, keys.edge],
    success: 'Edge node changed; the edge configuration is reloaded',
  });

  if (node.isPending) {
    return (
      <Page>
        <ListSkeleton rows={6} />
      </Page>
    );
  }
  if (node.isError) {
    return (
      <Page>
        {isApiError(node.error, 'not-found') ? (
          <EmptyState
            title="Node not found"
            action={
              <Link to="/nodes" className="text-sm underline">
                Back to nodes
              </Link>
            }
          />
        ) : (
          <ErrorAlert error={node.error} onRetry={() => void node.refetch()} />
        )}
      </Page>
    );
  }

  const data = node.data;
  const nodeApps = (apps.data?.items ?? []).filter((app) => app.nodeId === data.id);
  const docker = data.docker;

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link to="/nodes" className="hover:underline">
            Nodes
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            {data.name}
            <NodeStatusBadge status={data.status} />
            {data.isEdge && <StatusBadge tone="info">edge</StatusBadge>}
          </span>
        }
        description={data.hostname ?? undefined}
        actions={
          isAdmin && (
            <>
              <RenameDialog node={data} />
              <JoinTokenDialog node={data} />
              {!data.isEdge && (
                <ConfirmButton
                  title={`Make ${data.name} the edge node?`}
                  description="Caddy on this node takes over ports 80/443 and serves every route. Make sure the router forwards those ports to it."
                  confirmLabel="Make edge"
                  destructive={false}
                  onConfirm={() => makeEdge.mutate()}
                >
                  <Button variant="outline" disabled={data.status !== 'online'}>
                    <Shield /> Make edge
                  </Button>
                </ConfirmButton>
              )}
              <ConfirmButton
                title={`Remove ${data.name}?`}
                description={
                  nodeApps.length > 0
                    ? `${nodeApps.length} app(s) are assigned to this node; move them first.`
                    : 'Its credential is revoked and the agent is disconnected.'
                }
                confirmLabel="Remove node"
                confirmText={data.name}
                onConfirm={() => remove.mutate()}
              >
                <Button variant="destructive" disabled={data.isEdge || nodeApps.length > 0}>
                  <Trash2 /> Remove
                </Button>
              </ConfirmButton>
            </>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <Row label="LAN IP">
                <span className="font-mono">{data.lanIp ?? '—'}</span>
              </Row>
              <Row label="Architecture">{data.arch ?? '—'}</Row>
              <Row label="Agent version">{data.agentVersion ?? '—'}</Row>
              <Row label="Protocol">{data.protocolVersion ?? '—'}</Row>
              <Row label="Last seen">{formatRelative(data.lastSeenAt)}</Row>
              <Row label="Joined">{formatDateTime(data.joinedAt)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Docker</CardTitle>
            <CardDescription>Reported by the agent when it connects.</CardDescription>
          </CardHeader>
          <CardContent>
            {docker ? (
              <dl
                className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm"
                data-testid="docker-info"
              >
                <Row label="Engine">{docker.serverVersion}</Row>
                <Row label="Compose">{docker.composeVersion ?? '—'}</Row>
                <Row label="OS">{docker.operatingSystem}</Row>
                <Row label="Kernel">{docker.kernelVersion}</Row>
                <Row label="CPUs">{docker.cpus}</Row>
                <Row label="Memory">{formatBytes(docker.memoryBytes)}</Row>
                <Row label="Storage driver">{docker.storageDriver ?? '—'}</Row>
                <Row label="Root dir">
                  <span className="font-mono text-xs">{docker.rootDir ?? '—'}</span>
                </Row>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                The agent has not reported yet. Run it with a join token.
              </p>
            )}
          </CardContent>
        </Card>
        {isAdmin && data.joinedAt && (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Agent credential</CardTitle>
              <CardDescription>
                The agent authenticates with a long-lived credential it received when it joined.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <ConfirmButton
                title="Rotate the agent credential?"
                description="The connected agent receives and stores a new credential; the old one stops working."
                confirmLabel="Rotate"
                destructive={false}
                onConfirm={() => rotate.mutate()}
              >
                <Button variant="outline" disabled={data.status !== 'online' || rotate.isPending}>
                  <RefreshCw /> Rotate
                </Button>
              </ConfirmButton>
              <ConfirmButton
                title="Revoke the agent credential?"
                description="The agent is disconnected and its apps stop receiving deployments until it rejoins with a new join token."
                confirmLabel="Revoke"
                onConfirm={() => revoke.mutate()}
              >
                <Button variant="outline" disabled={revoke.isPending}>
                  <Ban /> Revoke
                </Button>
              </ConfirmButton>
              {data.status !== 'online' && (
                <p className="w-full text-xs text-muted-foreground">
                  Rotation needs the agent online.
                </p>
              )}
            </CardContent>
          </Card>
        )}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Apps on this node</CardTitle>
          </CardHeader>
          <CardContent>
            {nodeApps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No apps are assigned to this node.</p>
            ) : (
              <ul className="divide-y">
                {nodeApps.map((app) => (
                  <li key={app.id} className="flex items-center justify-between py-2">
                    <Link
                      to="/apps/$appId"
                      params={{ appId: app.id }}
                      className="font-medium hover:underline"
                    >
                      {app.name}
                    </Link>
                    {app.activeDeploymentId ? (
                      <StatusBadge tone="success">running</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">not running</StatusBadge>
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

function RenameDialog({ node }: { node: Node }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(node.name);
  const rename = useApiMutation(() => renameNode(node.id, name.trim()), {
    invalidate: [keys.nodes],
    success: 'Node renamed',
    onSuccess: () => setOpen(false),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Pencil /> Rename
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename node</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={name.trim() === '' || rename.isPending}>
              {rename.isPending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function JoinTokenDialog({ node }: { node: Node }) {
  const [join, setJoin] = useState<NodeJoinToken | null>(null);
  const create = useApiMutation(() => createJoinToken(node.id), { onSuccess: setJoin });
  return (
    <Dialog open={join !== null} onOpenChange={(open) => !open && setJoin(null)}>
      <Button variant="outline" onClick={() => create.mutate()} disabled={create.isPending}>
        {create.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Join token
      </Button>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Join {node.name}</DialogTitle>
          <DialogDescription>
            Use this to (re)connect the agent, e.g. after reinstalling the machine.
          </DialogDescription>
        </DialogHeader>
        {join && <JoinInstructions join={join} />}
      </DialogContent>
    </Dialog>
  );
}
