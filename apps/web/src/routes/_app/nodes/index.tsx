import { DisplayName, type NodeJoinToken } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2, Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { createNode, nodesQuery } from '@/api/nodes';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { NodeStatusBadge, StatusBadge } from '@/components/status-badge';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { JoinInstructions } from '@/features/nodes/join-instructions';
import { useCan } from '@/hooks/use-me';
import { fieldError } from '@/lib/form';
import { formatRelative } from '@/lib/format';

export const Route = createFileRoute('/_app/nodes/')({ component: NodeList });

function NodeList() {
  const nodes = useQuery(nodesQuery);
  const canAdd = useCan('admin');
  return (
    <Page>
      <PageHeader
        title="Nodes"
        description="Machines running the Slipway agent. One of them is the edge that runs Caddy."
        actions={canAdd && <AddNodeDialog />}
      />
      {nodes.isPending ? (
        <ListSkeleton rows={3} />
      ) : nodes.isError ? (
        <ErrorAlert error={nodes.error} onRetry={() => void nodes.refetch()} />
      ) : nodes.data.items.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No nodes"
          description="Add a node and run the agent on it with the snippet Slipway shows you."
          action={canAdd && <AddNodeDialog />}
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">LAN IP</TableHead>
                <TableHead className="hidden md:table-cell">Platform</TableHead>
                <TableHead className="hidden lg:table-cell">Agent</TableHead>
                <TableHead className="hidden sm:table-cell">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.data.items.map((node) => (
                <TableRow key={node.id}>
                  <TableCell>
                    <Link
                      to="/nodes/$nodeId"
                      params={{ nodeId: node.id }}
                      className="font-medium hover:underline"
                    >
                      {node.name}
                    </Link>
                    {node.isEdge && (
                      <StatusBadge tone="info" className="ml-2">
                        edge
                      </StatusBadge>
                    )}
                    <div className="text-xs text-muted-foreground">{node.hostname ?? ''}</div>
                  </TableCell>
                  <TableCell>
                    <NodeStatusBadge status={node.status} />
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs sm:table-cell">
                    {node.lanIp ?? '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {node.docker
                      ? `${node.docker.osType}/${node.docker.architecture}`
                      : (node.arch ?? '—')}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{node.agentVersion ?? '—'}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatRelative(node.lastSeenAt)}
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

function AddNodeDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [join, setJoin] = useState<NodeJoinToken | null>(null);
  const create = useApiMutation(() => createNode(name.trim()), {
    invalidate: [keys.nodes],
    success: (created) => `${created.node.name} added`,
    onSuccess: (created) => setJoin(created.joinToken),
  });
  const error = name === '' ? undefined : fieldError(DisplayName, name);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setJoin(null);
          setName('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add node
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{join ? `Join ${name}` : 'Add a node'}</DialogTitle>
          <DialogDescription>
            {join
              ? 'Copy one of the snippets now; the token is shown only once.'
              : 'Give the machine a name; Slipway creates a one-time join token for its agent.'}
          </DialogDescription>
        </DialogHeader>
        {join ? (
          <>
            <JoinInstructions join={join} />
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" error={error}>
              <Input
                placeholder="attic-nuc"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button
                type="submit"
                disabled={name.trim() === '' || error !== undefined || create.isPending}
              >
                {create.isPending && <Loader2 className="animate-spin" />}
                Create join token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
