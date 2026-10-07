import { type App, DisplayName, UpdateAppInput } from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { updateApp } from '@/api/apps';
import { connectionsQuery } from '@/api/github';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodesQuery } from '@/api/nodes';
import { Field } from '@/components/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useCan } from '@/hooks/use-me';
import { fieldError } from '@/lib/form';
import { PreviewsCard } from './previews-card';

/** Service names from a textarea: one per line, blanks ignored. */
function parseServiceList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function SettingsTab({ app }: { app: App }) {
  const nodes = useQuery(nodesQuery);
  const connections = useQuery(connectionsQuery);
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? '');
  const [connectionId, setConnectionId] = useState<string>(app.connectionId);
  const [sourceKind, setSourceKind] = useState(app.dockerfile ? 'dockerfile' : 'compose');
  const [composeFiles, setComposeFiles] = useState(
    (app.composeFiles ?? ['compose.yaml']).join('\n'),
  );
  const [dockerfile, setDockerfile] = useState(app.dockerfile ?? 'Dockerfile');
  const [context, setContext] = useState(app.context ?? '.');
  const [nodeId, setNodeId] = useState<string>(app.nodeId);
  const [autoDeploy, setAutoDeploy] = useState(app.autoDeployReleases);
  const [autoDeployPrereleases, setAutoDeployPrereleases] = useState(app.autoDeployPrereleases);
  const [autoDeployBranch, setAutoDeployBranch] = useState(app.autoDeployBranch ?? '');
  const [githubDeployments, setGithubDeployments] = useState(app.githubDeployments);
  const isAdmin = useCan('admin');
  const [proxyServices, setProxyServices] = useState(app.proxyServices.join('\n'));
  const proxyServiceList = parseServiceList(proxyServices);
  const proxyServicesChanged = proxyServiceList.join(',') !== app.proxyServices.join(',');

  const input = UpdateAppInput.safeParse({
    name,
    description: description.trim() === '' ? null : description,
    connectionId,
    ...(sourceKind === 'compose'
      ? {
          composeFiles: composeFiles
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        }
      : { dockerfile, context }),
    nodeId,
    autoDeployReleases: autoDeploy,
    autoDeployPrereleases,
    autoDeployBranch: autoDeployBranch.trim() === '' ? null : autoDeployBranch.trim(),
    githubDeployments,
    ...(isAdmin && proxyServicesChanged ? { proxyServices: proxyServiceList } : {}),
  });
  const autoDeployBranchError = input.success
    ? undefined
    : input.error.issues.find((issue) => issue.path[0] === 'autoDeployBranch')?.message;
  const proxyServicesError = input.success
    ? undefined
    : input.error.issues.find((issue) => issue.path[0] === 'proxyServices')?.message;
  const save = useApiMutation(
    () => (input.success ? updateApp(app.id, input.data) : Promise.reject(input.error)),
    { invalidate: [keys.apps], success: 'Settings saved' },
  );
  const nameError = fieldError(DisplayName, name);

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>
              The slug <code className="font-mono">{app.slug}</code> names containers and networks
              and cannot change.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Name" error={nameError}>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Description">
              <Textarea
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <CardDescription>
              {app.repository.owner}/{app.repository.name}; changes apply to the next deployment.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="GitHub connection">
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(connections.data?.items ?? []).map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Build from">
              <Select value={sourceKind} onValueChange={setSourceKind}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compose">Compose files</SelectItem>
                  <SelectItem value="dockerfile">Dockerfile</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {sourceKind === 'compose' ? (
              <Field label="Compose files" description="One path per line, merged in order.">
                <Textarea
                  rows={3}
                  className="font-mono"
                  value={composeFiles}
                  onChange={(event) => setComposeFiles(event.target.value)}
                />
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Dockerfile">
                  <Input
                    className="font-mono"
                    value={dockerfile}
                    onChange={(event) => setDockerfile(event.target.value)}
                  />
                </Field>
                <Field label="Build context">
                  <Input
                    className="font-mono"
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                  />
                </Field>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Node" description="Moving an app takes effect with the next deployment.">
              <Select value={nodeId} onValueChange={setNodeId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(nodes.data?.items ?? []).map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name} ({node.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="settings-auto-deploy">Deploy new releases automatically</Label>
                <p className="text-xs text-muted-foreground">
                  Each published GitHub release starts a deployment.
                </p>
              </div>
              <Switch
                id="settings-auto-deploy"
                checked={autoDeploy}
                onCheckedChange={setAutoDeploy}
              />
            </div>
            {autoDeploy && (
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div>
                  <Label htmlFor="settings-auto-deploy-prereleases">Include prereleases</Label>
                  <p className="text-xs text-muted-foreground">
                    Releases marked as prerelease deploy too. Drafts never do.
                  </p>
                </div>
                <Switch
                  id="settings-auto-deploy-prereleases"
                  checked={autoDeployPrereleases}
                  onCheckedChange={setAutoDeployPrereleases}
                />
              </div>
            )}
            <Field
              label="Deploy pushes to branch"
              error={autoDeployBranchError}
              description="Every push to this branch deploys the pushed commit (GitHub App connections). Leave empty to turn it off."
            >
              <Input
                className="font-mono"
                placeholder="main"
                value={autoDeployBranch}
                onChange={(event) => setAutoDeployBranch(event.target.value)}
              />
            </Field>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="settings-github-deployments">Show deployments on GitHub</Label>
                <p className="text-xs text-muted-foreground">
                  Records each deployment and its status in the repository's environments. Needs the
                  deployments permission on the GitHub connection.
                </p>
              </div>
              <Switch
                id="settings-github-deployments"
                checked={githubDeployments}
                onCheckedChange={setGithubDeployments}
              />
            </div>
            <Field
              label="Proxy network services"
              error={proxyServicesError}
              description={
                <>
                  One Compose service per line, attached to the proxy network as{' '}
                  <code className="font-mono">{app.slug}-&lt;service&gt;</code> without a public
                  route (e.g. a forward-auth gate). Routed services are attached anyway. Takes
                  effect with the next deployment.{isAdmin ? '' : ' Only admins can change this.'}
                </>
              }
            >
              <Textarea
                rows={2}
                className="font-mono"
                placeholder="oauth2-proxy"
                readOnly={!isAdmin}
                value={proxyServices}
                onChange={(event) => setProxyServices(event.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        <Button type="submit" className="self-start" disabled={!input.success || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Save settings
        </Button>
      </form>
      <TrustedMountsCard app={app} />
      <PreviewsCard app={app} />
    </div>
  );
}

/**
 * The admin-only trust switch. It saves on its own (only `trustedMounts`), so the settings form
 * of a member never sends it.
 */
function TrustedMountsCard({ app }: { app: App }) {
  const isAdmin = useCan('admin');
  const toggle = useApiMutation((trustedMounts: boolean) => updateApp(app.id, { trustedMounts }), {
    invalidate: [keys.apps],
    success: (updated) =>
      updated.trustedMounts
        ? 'Trusted mounts enabled; they apply to the next deployment'
        : 'Trusted mounts disabled; they apply to the next deployment',
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mounts</CardTitle>
        <CardDescription>
          Bind mounts, external volumes and custom volume names are refused unless an admin trusts
          this app.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div>
            <Label htmlFor="settings-trusted-mounts">Trusted mounts</Label>
            <p className="text-xs text-muted-foreground">
              Allows bind mounts below the node's allowed bind-mount roots, external volumes and
              custom volume names.{!isAdmin && ' Only an admin can change this.'}
            </p>
          </div>
          <Switch
            id="settings-trusted-mounts"
            checked={app.trustedMounts}
            disabled={!isAdmin || toggle.isPending}
            onCheckedChange={(checked) => toggle.mutate(checked)}
          />
        </div>
        {isAdmin && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>
              A trusted app can read and change host files below those roots and other projects'
              volumes, and anyone who can change its repository or Compose files gets the same
              access. Trust only apps whose source you control.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
