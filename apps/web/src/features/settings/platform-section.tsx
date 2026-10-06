import { Email, Hostname, HttpUrl, PublicUrl, type Settings } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodesQuery } from '@/api/nodes';
import { settingsQuery, updateSettings } from '@/api/platform';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
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
  forwardAuthUrl: string;
  edgeNodeId: string;
}

const NO_EDGE = '__none__';

function toForm(settings: Settings): PlatformForm {
  return {
    publicUrl: settings.publicUrl ?? '',
    acmeEmail: settings.acmeEmail ?? '',
    anchorHostname: settings.anchorHostname ?? '',
    dynamicDnsEnabled: settings.dynamicDnsEnabled,
    forwardAuthUrl: settings.forwardAuthUrl ?? '',
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
  const form = useForm<PlatformForm>({ values: toForm(settings) });
  const save = useApiMutation(
    (values: PlatformForm) =>
      updateSettings({
        publicUrl: values.publicUrl || null,
        acmeEmail: values.acmeEmail || null,
        anchorHostname: values.anchorHostname || null,
        dynamicDnsEnabled: values.dynamicDnsEnabled,
        forwardAuthUrl: values.forwardAuthUrl || null,
        edgeNodeId:
          values.edgeNodeId === NO_EDGE ? null : (values.edgeNodeId as Settings['edgeNodeId']),
      }),
    { invalidate: [keys.settings, keys.edge, keys.nodes], success: 'Platform settings saved' },
  );
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
              ? `SLIPWAY_PUBLIC_URL overrides this: ${settings.effectivePublicUrl}`
              : 'Where Slipway itself is reachable.'}
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
            Protected routes ask this endpoint whether a request may pass (Caddy{' '}
            <code>forward_auth</code>), e.g. an oauth2-proxy deployed as a Slipway app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="Forward-auth URL" error={errors.forwardAuthUrl?.message}>
            <Input
              placeholder="http://gate-proxy:4180/oauth2/auth"
              className="font-mono"
              {...register('forwardAuthUrl')}
            />
          </Field>
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
