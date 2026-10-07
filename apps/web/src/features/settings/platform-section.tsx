import {
  type AppId,
  Email,
  ForwardAuthUri,
  Hostname,
  HttpUrl,
  Port,
  PublicUrl,
  RoutableServiceName,
  type Settings,
  type SettingsHint,
} from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { appsQuery } from '@/api/apps';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodesQuery } from '@/api/nodes';
import { settingsQuery, updateSettings } from '@/api/platform';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { RadioCard, RadioCardGroup } from '@/components/radio-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { fieldError } from '@/lib/form';
import { formatRelative } from '@/lib/format';

/** Text settings; empty means "not set" (null in the API). */
const OPTIONAL_FIELDS = {
  publicUrl: PublicUrl,
  acmeEmail: Email,
  anchorHostname: Hostname,
  forwardAuthUrl: HttpUrl,
} as const;

interface PlatformForm {
  publicUrl: string;
  acmeEmail: string;
  anchorHostname: string;
  dynamicDnsEnabled: boolean;
  forwardAuthMode: ForwardAuthMode;
  forwardAuthUrl: string;
  gateAppId: string;
  gateService: string;
  gatePort: string;
  gateUri: string;
  edgeNodeId: string;
}

/** External URL (`forwardAuthUrl`) or a service of a Launchway app (`forwardAuthTarget`). */
type ForwardAuthMode = 'url' | 'target';

const NO_EDGE = '__none__';

/** The forward-auth part of the update: exactly one form is sent, the other is cleared. */
function forwardAuthPatch(
  values: Pick<
    PlatformForm,
    'forwardAuthMode' | 'forwardAuthUrl' | 'gateAppId' | 'gateService' | 'gatePort' | 'gateUri'
  >,
): Pick<Settings, 'forwardAuthUrl' | 'forwardAuthTarget'> {
  if (values.forwardAuthMode === 'url') {
    return { forwardAuthUrl: values.forwardAuthUrl || null, forwardAuthTarget: null };
  }
  if (!values.gateAppId) return { forwardAuthUrl: null, forwardAuthTarget: null };
  return {
    forwardAuthUrl: null,
    forwardAuthTarget: {
      appId: values.gateAppId as AppId,
      service: values.gateService,
      port: Number(values.gatePort),
      uri: values.gateUri || '/',
    },
  };
}

function toForm(settings: Settings): PlatformForm {
  return {
    publicUrl: settings.publicUrl ?? '',
    acmeEmail: settings.acmeEmail ?? '',
    anchorHostname: settings.anchorHostname ?? '',
    dynamicDnsEnabled: settings.dynamicDnsEnabled,
    forwardAuthMode: settings.forwardAuthTarget ? 'target' : 'url',
    forwardAuthUrl: settings.forwardAuthUrl ?? '',
    gateAppId: settings.forwardAuthTarget?.appId ?? '',
    gateService: settings.forwardAuthTarget?.service ?? '',
    gatePort: settings.forwardAuthTarget ? String(settings.forwardAuthTarget.port) : '',
    gateUri: settings.forwardAuthTarget?.uri ?? '/',
    edgeNodeId: settings.edgeNodeId ?? NO_EDGE,
  };
}

export function PlatformSection() {
  const settings = useQuery(settingsQuery);
  if (settings.isPending) return <ListSkeleton rows={6} />;
  if (settings.isError)
    return <ErrorAlert error={settings.error} onRetry={() => void settings.refetch()} />;
  return <PlatformFormCard settings={settings.data} />;
}

function PlatformFormCard({ settings }: { settings: Settings }) {
  const nodes = useQuery(nodesQuery);
  const apps = useQuery(appsQuery);
  const [hints, setHints] = useState<SettingsHint[]>([]);
  const form = useForm<PlatformForm>({ values: toForm(settings) });
  const save = useApiMutation(
    (values: PlatformForm) =>
      updateSettings({
        publicUrl: values.publicUrl || null,
        acmeEmail: values.acmeEmail || null,
        anchorHostname: values.anchorHostname || null,
        dynamicDnsEnabled: values.dynamicDnsEnabled,
        ...forwardAuthPatch(values),
        edgeNodeId:
          values.edgeNodeId === NO_EDGE ? null : (values.edgeNodeId as Settings['edgeNodeId']),
      }),
    {
      invalidate: [keys.settings, keys.edge, keys.nodes],
      success: 'Platform settings saved',
      onSuccess: (result) => setHints(result.hints),
    },
  );
  const mode = form.watch('forwardAuthMode');
  const gateAppId = form.watch('gateAppId');
  const gateApp = apps.data?.items.find((app) => app.id === gateAppId);
  const targetRequired = (value: string, check: () => string | true) =>
    mode !== 'target' || !gateAppId ? true : value === '' ? 'Required' : check();
  const errors = form.formState.errors;
  const register = (name: keyof typeof OPTIONAL_FIELDS) =>
    form.register(name, {
      validate: (value) =>
        typeof value !== 'string' ||
        value === '' ||
        (fieldError(OPTIONAL_FIELDS[name], value) ?? true),
    });

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => void form.handleSubmit((values) => save.mutate(values))(event)}
    >
      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
          <CardDescription>
            {settings.effectivePublicUrl && settings.effectivePublicUrl !== settings.publicUrl
              ? `LAUNCHWAY_PUBLIC_URL overrides this: ${settings.effectivePublicUrl}`
              : 'Where Launchway itself is reachable.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field
            label="Public URL"
            error={errors.publicUrl?.message}
            description="e.g. https://deploy.example.com"
          >
            <Input type="url" {...register('publicUrl')} />
          </Field>
          <Field label="Let's Encrypt e-mail" error={errors.acmeEmail?.message}>
            <Input type="email" {...register('acmeEmail')} />
          </Field>
          <Field label="Edge node" description="Runs Caddy and owns ports 80/443.">
            <Controller
              control={form.control}
              name="edgeNodeId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_EDGE}>None</SelectItem>
                    {(nodes.data?.items ?? []).map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.name} ({node.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dynamic DNS</CardTitle>
          <CardDescription>
            Public IPv4: <span className="font-mono">{settings.publicIpv4 ?? 'unknown'}</span>
            {settings.publicIpv4CheckedAt &&
              ` (checked ${formatRelative(settings.publicIpv4CheckedAt)})`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field
            label="Anchor host name"
            error={errors.anchorHostname?.message}
            description="Its A record follows the public IPv4; managed domains are CNAMEs to it."
          >
            <Input
              placeholder="home.example.com"
              className="font-mono"
              {...register('anchorHostname')}
            />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="ddns-enabled">Keep the anchor record up to date</Label>
              <p className="text-xs text-muted-foreground">
                Checks every 5 minutes through two IP services.
              </p>
            </div>
            <Controller
              control={form.control}
              name="dynamicDnsEnabled"
              render={({ field }) => (
                <Switch id="ddns-enabled" checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Forward auth</CardTitle>
          <CardDescription>
            Protected routes ask this gate whether a request may pass (Caddy{' '}
            <code>forward_auth</code>), e.g. an oauth2-proxy in front of a passkey login.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Controller
            control={form.control}
            name="forwardAuthMode"
            render={({ field }) => (
              <RadioCardGroup legend="Forward-auth gate" className="sm:flex-row">
                <RadioCard
                  name="forward-auth-mode"
                  value="url"
                  checked={field.value === 'url'}
                  onSelect={() => field.onChange('url')}
                >
                  <p className="text-sm font-medium">External URL</p>
                  <p className="text-xs text-muted-foreground">Any endpoint the edge can reach.</p>
                </RadioCard>
                <RadioCard
                  name="forward-auth-mode"
                  value="target"
                  checked={field.value === 'target'}
                  onSelect={() => field.onChange('target')}
                >
                  <p className="text-sm font-medium">App service</p>
                  <p className="text-xs text-muted-foreground">
                    A service of a Launchway app, reached by its alias on the proxy network.
                  </p>
                </RadioCard>
              </RadioCardGroup>
            )}
          />
          {mode === 'url' ? (
            <Field
              label="Forward-auth URL"
              error={errors.forwardAuthUrl?.message}
              description="Leave empty to turn forward auth off; protected routes then stay offline."
            >
              <Input
                placeholder="http://gate-proxy:4180/oauth2/auth"
                className="font-mono"
                {...register('forwardAuthUrl')}
              />
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="App" description="Leave empty to turn forward auth off.">
                <Controller
                  control={form.control}
                  name="gateAppId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose an app" />
                      </SelectTrigger>
                      <SelectContent>
                        {(apps.data?.items ?? []).map((app) => (
                          <SelectItem key={app.id} value={app.id}>
                            {app.name} ({app.slug})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field
                label="Service"
                error={errors.gateService?.message}
                description={
                  gateApp
                    ? `Reached as ${gateApp.slug}-${form.watch('gateService') || '<service>'}`
                    : 'Compose service name'
                }
              >
                <Input
                  placeholder="oauth2-proxy"
                  className="font-mono"
                  list="gate-services"
                  {...form.register('gateService', {
                    validate: (value) =>
                      targetRequired(value, () => fieldError(RoutableServiceName, value) ?? true),
                  })}
                />
              </Field>
              <datalist id="gate-services">
                {(gateApp?.proxyServices ?? []).map((service) => (
                  <option key={service} value={service} />
                ))}
              </datalist>
              <Field label="Port" error={errors.gatePort?.message}>
                <Input
                  inputMode="numeric"
                  placeholder="4180"
                  className="font-mono"
                  {...form.register('gatePort', {
                    validate: (value) =>
                      targetRequired(value, () => fieldError(Port, Number(value)) ?? true),
                  })}
                />
              </Field>
              <Field
                label="URI"
                error={errors.gateUri?.message}
                description="Path the gate answers on; defaults to /"
              >
                <Input
                  placeholder="/oauth2/auth"
                  className="font-mono"
                  {...form.register('gateUri', {
                    validate: (value) =>
                      value === '' ? true : (fieldError(ForwardAuthUri, value) ?? true),
                  })}
                />
              </Field>
            </div>
          )}
          {hints.length > 0 && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Action needed</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {hints.map((hint) => (
                    <li key={`${hint.code}-${hint.appId ?? ''}`}>{hint.message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Button
        type="submit"
        className="self-start"
        disabled={save.isPending || !form.formState.isDirty}
      >
        {save.isPending && <Loader2 className="animate-spin" />}
        Save platform settings
      </Button>
    </form>
  );
}
