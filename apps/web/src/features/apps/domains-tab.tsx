import {
  type App,
  Hostname,
  Port,
  ROUTE_OPTION_DEFAULTS,
  RoutableServiceName,
  type Route,
} from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Globe, Loader2, Plus, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { appStatusQuery } from '@/api/apps';
import {
  createDomain,
  createRoute,
  deleteRoute,
  domainsQuery,
  routesQuery,
  updateRoute,
} from '@/api/domains';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { settingsQuery } from '@/api/platform';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { DomainStatusBadge, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { VerifyButton } from '@/features/domains/verify-button';
import { AUTO_ZONE, ZoneSelect, zoneIdInput } from '@/features/domains/zone-select';
import { useCan } from '@/hooks/use-me';
import { isDomainServing } from '@/lib/domains';
import { fieldError } from '@/lib/form';
import { formatRelative } from '@/lib/format';

interface RouteOptions {
  protected: boolean;
  compress: boolean;
  hsts: boolean;
}

const OPTION_LABELS: Record<keyof RouteOptions, { label: string; hint: string }> = {
  protected: { label: 'Protected', hint: 'Require sign-in through the forward-auth gate' },
  compress: { label: 'Compress', hint: 'zstd/gzip responses' },
  hsts: { label: 'HSTS', hint: 'Browsers always use HTTPS for this name' },
};

function OptionSwitches({
  value,
  onChange,
  forwardAuthConfigured,
}: {
  value: RouteOptions;
  onChange: (value: RouteOptions) => void;
  forwardAuthConfigured: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      {(Object.keys(OPTION_LABELS) as (keyof RouteOptions)[]).map((option) => (
        <div key={option} className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor={`route-${option}`}>{OPTION_LABELS[option].label}</Label>
            <p className="text-xs text-muted-foreground">
              {option === 'protected' && !forwardAuthConfigured
                ? 'Set a forward-auth URL in platform settings first'
                : OPTION_LABELS[option].hint}
            </p>
          </div>
          <Switch
            id={`route-${option}`}
            checked={value[option]}
            disabled={option === 'protected' && !forwardAuthConfigured && !value.protected}
            onCheckedChange={(checked) => onChange({ ...value, [option]: checked })}
          />
        </div>
      ))}
    </div>
  );
}

export function DomainsTab({ app }: { app: App }) {
  const canEdit = useCan('member');
  const routes = useQuery(routesQuery(app.id));
  const domains = useQuery(domainsQuery);
  const domainById = new Map((domains.data?.items ?? []).map((domain) => [domain.id, domain]));
  const remove = useApiMutation(deleteRoute, {
    invalidate: [keys.routes, keys.edge],
    success: 'Route removed',
  });
  const appRoutes = (routes.data?.items ?? []).filter(
    (route) => route.target.kind === 'app' && route.target.appId === app.id,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-muted-foreground">
          Each domain routes HTTPS traffic to one service port. Certificates are requested once the
          DNS preflight passes.
        </p>
        {canEdit && <AddRouteDialog app={app} />}
      </div>
      {routes.isPending ? (
        <ListSkeleton rows={3} />
      ) : routes.isError ? (
        <ErrorAlert error={routes.error} onRetry={() => void routes.refetch()} />
      ) : appRoutes.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains"
          description="Add a domain to make the app reachable from the internet."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {appRoutes.map((route) => {
            const domain = domainById.get(route.domainId);
            return (
              <Card key={route.id} size="sm">
                <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`https://${route.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-mono font-medium hover:underline"
                      >
                        {route.hostname}
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                      {domain && <DomainStatusBadge status={domain.status} />}
                      {domain && (
                        <StatusBadge tone={isDomainServing(domain.status) ? 'success' : 'neutral'}>
                          {domain.status === 'active'
                            ? 'served by the edge'
                            : isDomainServing(domain.status)
                              ? 'waiting for the edge'
                              : 'tls waiting for dns'}
                        </StatusBadge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      →{' '}
                      {route.target.kind === 'app'
                        ? `${route.target.service}:${route.target.port}`
                        : ''}
                      {route.protected && ' · protected'}
                      {route.compress && ' · compressed'}
                      {route.hsts && ' · HSTS'}
                      {domain && ` · ${domain.managed ? 'managed DNS' : 'external DNS'}`}
                      {domain?.lastCheckedAt &&
                        ` · checked ${formatRelative(domain.lastCheckedAt)}`}
                    </p>
                    {domain?.statusMessage && !isDomainServing(domain.status) && (
                      <p className="text-xs text-destructive">{domain.statusMessage}</p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <VerifyButton domainId={route.domainId} hostname={route.hostname} />
                      <EditRouteDialog route={route} />
                      <ConfirmButton
                        title={`Remove ${route.hostname}?`}
                        description="The edge stops serving this name for the app. The domain itself stays and can be routed again."
                        confirmLabel="Remove route"
                        onConfirm={() => remove.mutate(route.id)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${route.hostname}`}
                        >
                          <Trash2 />
                        </Button>
                      </ConfirmButton>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const NEW_DOMAIN = '__new__';

function AddRouteDialog({ app }: { app: App }) {
  const [open, setOpen] = useState(false);
  const [domainChoice, setDomainChoice] = useState(NEW_DOMAIN);
  const [hostname, setHostname] = useState('');
  const [zone, setZone] = useState(AUTO_ZONE);
  const [service, setService] = useState('');
  const [port, setPort] = useState('80');
  const [options, setOptions] = useState<RouteOptions>({ ...ROUTE_OPTION_DEFAULTS });
  const domains = useQuery({ ...domainsQuery, enabled: open });
  const routes = useQuery({ ...routesQuery(), enabled: open });
  const status = useQuery({
    ...appStatusQuery(app.id),
    enabled: open && app.activeDeploymentId !== null,
  });
  const settings = useQuery({ ...settingsQuery, enabled: open });

  const routedDomainIds = new Set((routes.data?.items ?? []).map((route) => route.domainId));
  const freeDomains = (domains.data?.items ?? []).filter(
    (domain) => !routedDomainIds.has(domain.id),
  );
  const services = status.data?.services.map((item) => item.service) ?? [];

  const hostnameError =
    domainChoice === NEW_DOMAIN && hostname !== '' ? fieldError(Hostname, hostname) : undefined;
  const serviceError = service !== '' ? fieldError(RoutableServiceName, service) : undefined;
  const portError = Port.safeParse(Number(port)).success
    ? undefined
    : 'Enter a port between 1 and 65535';

  const save = useApiMutation(
    async () => {
      const domainId =
        domainChoice === NEW_DOMAIN
          ? (await createDomain({ hostname, ...zoneIdInput(zone) })).id
          : domainChoice;
      return createRoute({
        domainId: domainId as Route['domainId'],
        target: { kind: 'app', appId: app.id, service, port: Number(port) },
        ...options,
      });
    },
    {
      invalidate: [keys.routes, keys.domains, keys.edge],
      success: (route) => `${route.hostname} routed to ${service}:${port}`,
      onSuccess: () => {
        setOpen(false);
        setHostname('');
        setService('');
      },
    },
  );

  const ready =
    (domainChoice !== NEW_DOMAIN || (hostname !== '' && !hostnameError)) &&
    service !== '' &&
    !serviceError &&
    !portError;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add domain
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>Route a host name to a service of {app.name}.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Domain">
            <Select value={domainChoice} onValueChange={setDomainChoice}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_DOMAIN}>New domain…</SelectItem>
                {freeDomains.map((domain) => (
                  <SelectItem key={domain.id} value={domain.id}>
                    {domain.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {domainChoice === NEW_DOMAIN && (
            <>
              <Field label="Host name" error={hostnameError}>
                <Input
                  className="font-mono"
                  placeholder={`${app.slug}.example.com`}
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                />
              </Field>
              <Field
                label="DNS"
                description="Managed zones get a CNAME to the anchor host name automatically."
              >
                <ZoneSelect value={zone} onChange={setZone} />
              </Field>
            </>
          )}
          <div className="grid grid-cols-[1fr_8rem] gap-4">
            <Field label="Service" error={serviceError}>
              {services.length > 0 ? (
                <Select value={service} onValueChange={setService}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="font-mono"
                  placeholder="web"
                  value={service}
                  onChange={(event) => setService(event.target.value)}
                />
              )}
            </Field>
            <Field label="Port" error={port === '' ? undefined : portError}>
              <Input
                inputMode="numeric"
                className="font-mono"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </Field>
          </div>
          <OptionSwitches
            value={options}
            onChange={setOptions}
            forwardAuthConfigured={Boolean(settings.data?.forwardAuthUrl)}
          />
          <DialogFooter>
            <Button type="submit" disabled={!ready || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRouteDialog({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RouteOptions>({
    protected: route.protected,
    compress: route.compress,
    hsts: route.hsts,
  });
  const [port, setPort] = useState(route.target.kind === 'app' ? String(route.target.port) : '');
  const settings = useQuery({ ...settingsQuery, enabled: open });
  const save = useApiMutation(
    () =>
      updateRoute(route.id, {
        ...options,
        ...(route.target.kind === 'app' ? { target: { ...route.target, port: Number(port) } } : {}),
      }),
    {
      invalidate: [keys.routes, keys.edge],
      success: 'Route updated',
      onSuccess: () => setOpen(false),
    },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${route.hostname}`}>
          <Settings2 />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono">{route.hostname}</DialogTitle>
          <DialogDescription>Route options</DialogDescription>
        </DialogHeader>
        {route.target.kind === 'app' && (
          <Field label={`Port of ${route.target.service}`}>
            <Input
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </Field>
        )}
        <OptionSwitches
          value={options}
          onChange={setOptions}
          forwardAuthConfigured={Boolean(settings.data?.forwardAuthUrl)}
        />
        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
