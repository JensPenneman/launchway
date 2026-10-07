import {
  CreatePatConnectionInput,
  type GitHubConnection,
  type GitHubConnectionCapabilities,
  GitHubLogin,
} from '@launchway/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  FolderGit2,
  KeyRound,
  Loader2,
  RefreshCw,
  Rocket,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  capabilitiesQuery,
  connectionsQuery,
  createPatConnection,
  deleteConnection,
  refreshCapabilities,
  startAppManifest,
  submitManifestForm,
} from '@/api/github';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { StatusBadge } from '@/components/status-badge';
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
import { fieldError, zodResolver } from '@/lib/form';
import { formatRelative } from '@/lib/format';

export function GitHubSection() {
  const connections = useQuery(connectionsQuery);
  const remove = useApiMutation(deleteConnection, {
    invalidate: [keys.github],
    success: 'Connection removed',
  });
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderGit2 className="size-4" /> GitHub App
              <StatusBadge tone="info">recommended</StatusBadge>
            </CardTitle>
            <CardDescription>
              Launchway registers its own GitHub App for you: repository access you choose per
              installation, release webhooks for auto-deploy, short-lived clone tokens.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateAppDialog />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> Personal access token
            </CardTitle>
            <CardDescription>
              A fine-grained token with <em>Contents: read</em> and <em>Metadata: read</em>. No
              webhooks: releases are polled every 5 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PatDialog />
          </CardContent>
        </Card>
      </div>
      {connections.isPending ? (
        <ListSkeleton rows={2} />
      ) : connections.isError ? (
        <ErrorAlert error={connections.error} />
      ) : connections.data.items.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No GitHub connections"
          description="Connect GitHub to create apps."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="GitHub connections">
          {connections.data.items.map((connection) => (
            <li key={connection.id}>
              <Card size="sm">
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {connection.name}
                        <StatusBadge tone="neutral">
                          {connection.kind === 'app' ? 'GitHub App' : 'token'}
                        </StatusBadge>
                        {connection.webhooksEnabled && (
                          <StatusBadge tone="success">webhooks</StatusBadge>
                        )}
                        {connection.app && connection.app.installationId === null && (
                          <StatusBadge tone="warning">not installed</StatusBadge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {connection.account
                          ? `${connection.account.login} (${connection.account.type})`
                          : 'account unknown'}{' '}
                        · added {formatRelative(connection.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {connection.app && (
                        <Button variant="outline" size="sm" asChild>
                          <a href={connection.app.installUrl} target="_blank" rel="noreferrer">
                            <ExternalLink />
                            {connection.app.installationId === null
                              ? 'Install'
                              : 'Configure repositories'}
                          </a>
                        </Button>
                      )}
                      <ConfirmButton
                        title={`Remove ${connection.name}?`}
                        description="Apps using this connection can no longer be deployed until you pick another connection."
                        confirmLabel="Remove connection"
                        onConfirm={() => remove.mutate(connection.id)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${connection.name}`}
                        >
                          <Trash2 />
                        </Button>
                      </ConfirmButton>
                    </div>
                  </div>
                  {(connection.kind === 'pat' || connection.app?.installationId != null) && (
                    <ConnectionCapabilities connection={connection} />
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Whether Launchway may record deployments (and read pull requests) on GitHub, with a link to
 * grant what is missing. Apps created before these permissions existed need an update on GitHub.
 */
function ConnectionCapabilities({ connection }: { connection: GitHubConnection }) {
  const capabilities = useQuery(capabilitiesQuery(connection.id));
  const queryClient = useQueryClient();
  const refresh = useApiMutation(() => refreshCapabilities(connection.id), {
    onSuccess: (data) => queryClient.setQueryData(capabilitiesQuery(connection.id).queryKey, data),
  });
  if (capabilities.isPending) {
    return <p className="text-xs text-muted-foreground">Checking GitHub permissions...</p>;
  }
  if (capabilities.isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Could not check the permissions of this connection on GitHub.
      </p>
    );
  }
  const caps = capabilities.data;
  if (caps.missing.length === 0 && caps.lastDeniedAt === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Rocket className="size-3.5" aria-hidden="true" />
        Deployments show on GitHub
        {caps.pullRequests ? '; pull requests can be previewed.' : '.'}
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-sm"
      role="status"
      aria-label={`GitHub permissions of ${connection.name}`}
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        Grant in GitHub to show deployments there
      </p>
      <p className="text-xs text-muted-foreground">{capabilityHint(caps)}</p>
      {caps.missing.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Missing on GitHub">
          {caps.missing.map((item) => (
            <li key={item}>
              <StatusBadge tone="warning">{item}</StatusBadge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" size="sm" asChild>
          <a href={caps.settingsUrl} target="_blank" rel="noreferrer">
            <ExternalLink />
            {caps.kind === 'app' ? 'App permissions' : 'Token settings'}
          </a>
        </Button>
        {caps.installationSettingsUrl && (
          <Button variant={caps.pendingApproval ? 'default' : 'outline'} size="sm" asChild>
            <a href={caps.installationSettingsUrl} target="_blank" rel="noreferrer">
              <ExternalLink /> Approve on the installation
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw className={refresh.isPending ? 'animate-spin' : undefined} /> Check again
        </Button>
      </div>
    </div>
  );
}

function capabilityHint(caps: GitHubConnectionCapabilities): string {
  if (caps.kind === 'pat') {
    return caps.lastDeniedAt
      ? `GitHub refused to record a deployment (${formatRelative(caps.lastDeniedAt)}). Give the token Deployments: read and write (and Pull requests: read for previews).`
      : 'Give the token Deployments: read and write (and Pull requests: read for previews) on the repositories it deploys.';
  }
  if (caps.pendingApproval) {
    return 'The app requests the new permissions; the account it is installed on still has to approve them.';
  }
  if (caps.missing.length === 0) {
    return `GitHub refused to record a deployment (${formatRelative(caps.lastDeniedAt ?? caps.checkedAt)}). Check that the installation includes the repository.`;
  }
  return 'This app was created before Launchway reported deployments. In its permissions, set Deployments to read and write and Pull requests to read, subscribe to Pull request events, save, then approve the change on the installation.';
}

function CreateAppDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [organization, setOrganization] = useState('');
  const start = useApiMutation(
    () =>
      startAppManifest({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(organization.trim() ? { organization: organization.trim() } : {}),
      }),
    // Leaves the page: GitHub shows the app for confirmation and redirects back with a code.
    { onSuccess: submitManifestForm },
  );
  const orgError = organization === '' ? undefined : fieldError(GitHubLogin, organization);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <FolderGit2 /> Create GitHub App
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a GitHub App</DialogTitle>
          <DialogDescription>
            You confirm the app on GitHub, then install it on the repositories Launchway may deploy.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            start.mutate();
          }}
        >
          <Field
            label="App name (optional)"
            description="Must be unique on GitHub; defaults to one derived from the platform URL."
          >
            <Input maxLength={34} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field
            label="Organization (optional)"
            error={orgError}
            description="Leave empty to create it under your personal account."
          >
            <Input value={organization} onChange={(event) => setOrganization(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={orgError !== undefined || start.isPending}>
              {start.isPending && <Loader2 className="animate-spin" />}
              Continue on GitHub
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PatDialog() {
  const [open, setOpen] = useState(false);
  const form = useForm({
    resolver: zodResolver(CreatePatConnectionInput),
    defaultValues: { name: '', token: '' },
  });
  const create = useApiMutation(createPatConnection, {
    invalidate: [keys.github],
    success: (connection) => `${connection.name} connected`,
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  const errors = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <KeyRound /> Add token
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect with a personal access token</DialogTitle>
          <DialogDescription>
            Create a{' '}
            <a
              className="underline underline-offset-4"
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              fine-grained token
            </a>{' '}
            with read access to contents and metadata of the repositories to deploy.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => void form.handleSubmit((values) => create.mutate(values))(event)}
        >
          <Field label="Name" error={errors.name?.message}>
            <Input placeholder="My repositories" {...form.register('name')} />
          </Field>
          <Field label="Token" error={errors.token?.message}>
            <Input
              type="password"
              autoComplete="off"
              className="font-mono"
              {...form.register('token')}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
