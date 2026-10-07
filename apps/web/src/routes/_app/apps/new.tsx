import {
  CreateAppInput,
  type GitHubConnection,
  type GitHubRepo,
  type Node,
} from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { FolderGit2, Loader2, Lock, Search, Server } from 'lucide-react';
import { useState } from 'react';
import { createApp } from '@/api/apps';
import { connectionsQuery, reposQuery } from '@/api/github';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodesQuery } from '@/api/nodes';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { RadioCard, RadioCardGroup } from '@/components/radio-card';
import { NodeStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useCan } from '@/hooks/use-me';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/apps/new')({ component: NewApp });

const STEPS = ['Connection', 'Repository', 'Build', 'Node'] as const;

type SourceKind = 'compose' | 'dockerfile';

interface Draft {
  connection: GitHubConnection | null;
  repo: GitHubRepo | null;
  sourceKind: SourceKind;
  composeFiles: string;
  dockerfile: string;
  context: string;
  nodeId: string;
  name: string;
  slug: string;
  autoDeployReleases: boolean;
}

const INITIAL: Draft = {
  connection: null,
  repo: null,
  sourceKind: 'compose',
  composeFiles: 'compose.yaml',
  dockerfile: 'Dockerfile',
  context: '.',
  nodeId: '',
  name: '',
  slug: '',
  autoDeployReleases: false,
};

/** Builds the API input from the wizard state (compose files: one path per line). */
function draftToInput(draft: Draft) {
  const files = draft.composeFiles
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return CreateAppInput.safeParse({
    name: draft.name.trim(),
    ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
    connectionId: draft.connection?.id,
    repository: draft.repo ? { owner: draft.repo.owner, name: draft.repo.name } : undefined,
    ...(draft.sourceKind === 'compose'
      ? { composeFiles: files }
      : { dockerfile: draft.dockerfile.trim(), context: draft.context.trim() || '.' }),
    nodeId: draft.nodeId,
    autoDeployReleases: draft.autoDeployReleases,
  });
}

function NewApp() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const navigate = useNavigate();
  const canCreate = useCan('member');
  const create = useApiMutation(createApp, {
    invalidate: [keys.apps],
    success: (app) => `${app.name} created`,
    onSuccess: (app) =>
      void navigate({
        to: '/apps/$appId',
        params: { appId: app.id },
        search: { tab: 'deployments' },
      }),
  });

  if (!canCreate) {
    return (
      <Page>
        <PageHeader title="New app" />
        <EmptyState title="Read-only access" description="Viewers cannot create apps." />
      </Page>
    );
  }

  const parsed = draftToInput(draft);
  const canContinue = [
    draft.connection !== null,
    draft.repo !== null,
    draft.sourceKind === 'compose'
      ? draft.composeFiles.trim() !== ''
      : draft.dockerfile.trim() !== '',
    parsed.success,
  ][step];

  return (
    <Page>
      <PageHeader
        title="New app"
        eyebrow={
          <Link to="/apps" className="hover:underline">
            Apps
          </Link>
        }
        description="Link a GitHub repository, tell Launchway how to build it and where to run it."
      />
      <ol className="grid grid-cols-4 gap-2 text-xs sm:text-sm" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined}>
            <span
              className={cn(
                'mb-1.5 block h-1 rounded-full',
                index <= step ? 'bg-primary' : 'bg-muted',
              )}
              aria-hidden="true"
            />
            <span className={index === step ? 'font-medium' : 'text-muted-foreground'}>
              {label}
            </span>
          </li>
        ))}
      </ol>
      <Card>
        <CardHeader>
          <CardTitle>{STEPS[step]}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 0 && (
            <ConnectionStep
              selected={draft.connection}
              onSelect={(connection) => update({ connection, repo: null })}
            />
          )}
          {step === 1 && draft.connection && (
            <RepositoryStep
              connectionId={draft.connection.id}
              selected={draft.repo}
              onSelect={(repo) => update({ repo, name: draft.name || repo.name, slug: draft.slug })}
            />
          )}
          {step === 2 && <SourceStep draft={draft} update={update} />}
          {step === 3 && (
            <NodeStep draft={draft} update={update} errors={parsed.error?.issues ?? []} />
          )}
          <div className="flex justify-between gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={step === 0}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep(step + 1)} disabled={!canContinue}>
                Continue
              </Button>
            ) : (
              <Button
                onClick={() => parsed.success && create.mutate(parsed.data)}
                disabled={!parsed.success || create.isPending}
              >
                {create.isPending && <Loader2 className="animate-spin" />}
                Create app
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}

function ConnectionStep({
  selected,
  onSelect,
}: {
  selected: GitHubConnection | null;
  onSelect: (connection: GitHubConnection) => void;
}) {
  const connections = useQuery(connectionsQuery);
  if (connections.isPending) return <ListSkeleton rows={2} />;
  if (connections.isError) return <ErrorAlert error={connections.error} />;
  if (connections.data.items.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        title="No GitHub connection"
        description="Launchway needs a GitHub App or a personal access token to read your repositories."
        action={
          <Button asChild size="sm">
            <Link to="/settings" search={{ tab: 'github' }}>
              Connect GitHub
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <RadioCardGroup legend="GitHub connection">
      {connections.data.items.map((connection) => (
        <RadioCard
          key={connection.id}
          name="connection"
          value={connection.id}
          checked={selected?.id === connection.id}
          onSelect={() => onSelect(connection)}
        >
          <div className="font-medium">{connection.name}</div>
          <div className="text-xs text-muted-foreground">
            {connection.kind === 'app' ? 'GitHub App' : 'Personal access token'}
            {connection.account && ` · ${connection.account.login}`}
          </div>
        </RadioCard>
      ))}
    </RadioCardGroup>
  );
}

function RepositoryStep({
  connectionId,
  selected,
  onSelect,
}: {
  connectionId: string;
  selected: GitHubRepo | null;
  onSelect: (repo: GitHubRepo) => void;
}) {
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim(), 300);
  const repos = useQuery(reposQuery(connectionId, query));
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search
          className="absolute top-2 left-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          aria-label="Search repositories"
          placeholder="Search repositories"
          className="pl-8"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {repos.isPending ? (
        <ListSkeleton rows={4} />
      ) : repos.isError ? (
        <ErrorAlert error={repos.error} />
      ) : repos.data.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No repositories found.</p>
      ) : (
        <RadioCardGroup legend="Repository" className="max-h-96 overflow-y-auto p-0.5">
          {repos.data.items.map((repo) => (
            <RadioCard
              key={repo.id}
              name="repository"
              value={String(repo.id)}
              checked={selected?.id === repo.id}
              onSelect={() => onSelect(repo)}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {repo.fullName}
                {repo.private && (
                  <Lock className="size-3 text-muted-foreground" aria-label="private" />
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {repo.description ?? 'No description'}
                {repo.pushedAt && ` · pushed ${formatRelative(repo.pushedAt)}`}
              </div>
            </RadioCard>
          ))}
        </RadioCardGroup>
      )}
    </div>
  );
}

function SourceStep({ draft, update }: { draft: Draft; update: (patch: Partial<Draft>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <RadioCardGroup legend="Build source" className="grid gap-2 sm:grid-cols-2">
        <RadioCard
          name="source"
          value="compose"
          checked={draft.sourceKind === 'compose'}
          onSelect={() => update({ sourceKind: 'compose' })}
        >
          <div className="font-medium">Compose files</div>
          <div className="text-xs text-muted-foreground">The repository has a compose.yaml</div>
        </RadioCard>
        <RadioCard
          name="source"
          value="dockerfile"
          checked={draft.sourceKind === 'dockerfile'}
          onSelect={() => update({ sourceKind: 'dockerfile' })}
        >
          <div className="font-medium">Dockerfile</div>
          <div className="text-xs text-muted-foreground">
            Launchway generates a one-service Compose file
          </div>
        </RadioCard>
      </RadioCardGroup>
      {draft.sourceKind === 'compose' ? (
        <Field
          label="Compose files"
          description="Paths relative to the repository root, one per line; merged in order."
        >
          <Textarea
            rows={3}
            className="font-mono"
            value={draft.composeFiles}
            onChange={(event) => update({ composeFiles: event.target.value })}
          />
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dockerfile">
            <Input
              className="font-mono"
              value={draft.dockerfile}
              onChange={(event) => update({ dockerfile: event.target.value })}
            />
          </Field>
          <Field label="Build context">
            <Input
              className="font-mono"
              value={draft.context}
              onChange={(event) => update({ context: event.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function NodeStep({
  draft,
  update,
  errors,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  errors: readonly { path: PropertyKey[]; message: string }[];
}) {
  const nodes = useQuery(nodesQuery);
  const errorFor = (field: string) =>
    draft.name || draft.slug ? errors.find((issue) => issue.path[0] === field)?.message : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errorFor('name')}>
          <Input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
        </Field>
        <Field
          label="Slug (optional)"
          error={errorFor('slug')}
          description="Derived from the name when empty; cannot be changed later."
        >
          <Input
            className="font-mono"
            value={draft.slug}
            onChange={(event) => update({ slug: event.target.value })}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Node</span>
        {nodes.isPending ? (
          <ListSkeleton rows={2} />
        ) : nodes.isError ? (
          <ErrorAlert error={nodes.error} />
        ) : nodes.data.items.length === 0 ? (
          <EmptyState icon={Server} title="No nodes" description="Add a node first." />
        ) : (
          <RadioCardGroup legend="Node" className="grid gap-2 sm:grid-cols-2">
            {nodes.data.items.map((node: Node) => (
              <RadioCard
                key={node.id}
                name="node"
                value={node.id}
                checked={draft.nodeId === node.id}
                onSelect={() => update({ nodeId: node.id })}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{node.name}</span>
                  <NodeStatusBadge status={node.status} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {[node.arch, node.lanIp, node.isEdge ? 'edge' : null].filter(Boolean).join(' · ')}
                </div>
              </RadioCard>
            ))}
          </RadioCardGroup>
        )}
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div>
          <Label htmlFor="auto-deploy">Deploy new releases automatically</Label>
          <p className="text-xs text-muted-foreground">
            Every published GitHub release of {draft.repo?.fullName ?? 'the repository'} is
            deployed.
          </p>
        </div>
        <Switch
          id="auto-deploy"
          checked={draft.autoDeployReleases}
          onCheckedChange={(checked) => update({ autoDeployReleases: checked })}
        />
      </div>
    </div>
  );
}
