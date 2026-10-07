import { Hostname } from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Globe, Loader2, Network, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react';
import { useState } from 'react';
import { appsQuery } from '@/api/apps';
import {
  createDomain,
  ddnsQuery,
  deleteDomain,
  dnsAccountsQuery,
  domainsQuery,
  providersQuery,
  routesQuery,
  runDdns,
  syncDnsAccount,
  updateDomain,
  zonesQuery,
} from '@/api/domains';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { DomainStatusBadge, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecordsPanel } from '@/features/domains/records-panel';
import { VerifyButton } from '@/features/domains/verify-button';
import { AUTO_ZONE, ZoneSelect, zoneIdInput } from '@/features/domains/zone-select';
import { useCan } from '@/hooks/use-me';
import { isDomainServing } from '@/lib/domains';
import { fieldError } from '@/lib/form';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const TABS = ['domains', 'zones', 'ddns'] as const;
type DomainsTab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/domains')({
  validateSearch: (search: Record<string, unknown>): { tab?: DomainsTab; zone?: string } => ({
    ...(TABS.includes(search.tab as DomainsTab) ? { tab: search.tab as DomainsTab } : {}),
    ...(typeof search.zone === 'string' ? { zone: search.zone } : {}),
  }),
  component: DomainsPage,
});

function DomainsPage() {
  const { tab = 'domains' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Page>
      <PageHeader
        title="Domains"
        description="Host names Launchway serves, the DNS zones it manages and the dynamic DNS anchor."
      />
      <Tabs
        value={tab}
        onValueChange={(value) => void navigate({ search: { tab: value as DomainsTab } })}
      >
        <TabsList>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="zones">DNS zones</TabsTrigger>
          <TabsTrigger value="ddns">Dynamic DNS</TabsTrigger>
        </TabsList>
        <TabsContent value="domains" className="mt-4">
          <DomainsTable />
        </TabsContent>
        <TabsContent value="zones" className="mt-4">
          <ZonesPanel />
        </TabsContent>
        <TabsContent value="ddns" className="mt-4">
          <DdnsCard />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function DomainsTable() {
  const canEdit = useCan('member');
  const domains = useQuery(domainsQuery);
  const routes = useQuery(routesQuery());
  const apps = useQuery(appsQuery);
  const zones = useQuery(zonesQuery);
  const appNames = new Map((apps.data?.items ?? []).map((app) => [app.id, app.name]));
  const zoneNames = new Map((zones.data?.items ?? []).map((zone) => [zone.id, zone.name]));
  const routeByDomain = new Map((routes.data?.items ?? []).map((route) => [route.domainId, route]));
  const remove = useApiMutation(deleteDomain, {
    invalidate: [keys.domains, keys.routes, keys.edge],
    success: 'Domain deleted',
  });
  const setForce = useApiMutation(
    ({ id, force }: { id: string; force: boolean }) => updateDomain(id, { force }),
    {
      invalidate: [keys.domains, keys.edge],
      success: (domain) =>
        domain.force
          ? `${domain.hostname} is served even when the DNS check fails`
          : `${domain.hostname} waits for the DNS check again`,
    },
  );

  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <div className="flex justify-end">
          <AddDomainDialog />
        </div>
      )}
      {domains.isPending ? (
        <ListSkeleton rows={5} />
      ) : domains.isError ? (
        <ErrorAlert error={domains.error} onRetry={() => void domains.refetch()} />
      ) : domains.data.items.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains"
          description="Add a domain from an app's Domains tab, or here to route it later."
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Host name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">DNS</TableHead>
                <TableHead className="hidden sm:table-cell">Serves</TableHead>
                <TableHead className="hidden xl:table-cell">Checked</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.data.items.map((domain) => {
                const route = routeByDomain.get(domain.id);
                const target = route?.target;
                return (
                  <TableRow key={domain.id}>
                    <TableCell>
                      <span className="font-mono text-sm">{domain.hostname}</span>
                      {domain.statusMessage && !isDomainServing(domain.status) && (
                        <p
                          className="max-w-xs truncate text-xs text-destructive"
                          title={domain.statusMessage}
                        >
                          {domain.statusMessage}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <DomainStatusBadge status={domain.status} />
                        {domain.force && <StatusBadge tone="warning">forced</StatusBadge>}
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {domain.zoneId ? (
                        <span>
                          managed ·{' '}
                          <span className="font-mono text-xs">
                            {zoneNames.get(domain.zoneId) ?? 'zone'}
                          </span>
                          {domain.proxied && ' · proxied'}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">external</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {!target ? (
                        <span className="text-muted-foreground">not routed</span>
                      ) : target.kind === 'app' ? (
                        <Link
                          to="/apps/$appId"
                          params={{ appId: target.appId }}
                          search={{ tab: 'domains' }}
                          className="hover:underline"
                        >
                          {appNames.get(target.appId) ?? 'app'} · {target.service}:{target.port}
                        </Link>
                      ) : target.kind === 'external' ? (
                        <span className="font-mono text-xs">
                          {target.scheme}://{target.host}:{target.port}
                        </span>
                      ) : (
                        <span className="text-xs">→ {target.to}</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">
                      {formatRelative(domain.lastCheckedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {canEdit && (
                        <div className="flex justify-end gap-1">
                          <VerifyButton domainId={domain.id} hostname={domain.hostname} compact />
                          {domain.force ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setForce.mutate({ id: domain.id, force: false })}
                            >
                              Unforce
                            </Button>
                          ) : (
                            !isDomainServing(domain.status) && (
                              <ConfirmButton
                                title={`Serve ${domain.hostname} without a passing DNS check?`}
                                description="The edge requests a certificate right away. If DNS is wrong, Let's Encrypt attempts fail and may hit rate limits."
                                confirmLabel="Force"
                                onConfirm={() => setForce.mutate({ id: domain.id, force: true })}
                              >
                                <Button variant="ghost" size="sm">
                                  Force
                                </Button>
                              </ConfirmButton>
                            )
                          )}
                          <ConfirmButton
                            title={`Delete ${domain.hostname}?`}
                            description={
                              domain.managed
                                ? 'Its route and the DNS record Launchway created are removed.'
                                : 'Its route is removed; DNS records you created stay untouched.'
                            }
                            confirmLabel="Delete domain"
                            onConfirm={() => remove.mutate(domain.id)}
                          >
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Delete ${domain.hostname}`}
                            >
                              <Trash2 />
                            </Button>
                          </ConfirmButton>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AddDomainDialog() {
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState('');
  const [zone, setZone] = useState(AUTO_ZONE);
  const create = useApiMutation(() => createDomain({ hostname, ...zoneIdInput(zone) }), {
    invalidate: [keys.domains],
    success: (domain) => `${domain.hostname} added`,
    onSuccess: () => {
      setOpen(false);
      setHostname('');
    },
  });
  const error = hostname === '' ? undefined : fieldError(Hostname, hostname);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>Route it to an app from the app's Domains tab.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Host name" error={error}>
            <Input
              className="font-mono"
              placeholder="app.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
          </Field>
          <Field label="DNS">
            <ZoneSelect value={zone} onChange={setZone} />
          </Field>
          <DialogFooter>
            <Button
              type="submit"
              disabled={hostname === '' || error !== undefined || create.isPending}
            >
              {create.isPending && <Loader2 className="animate-spin" />}
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ZonesPanel() {
  const { zone: selectedZoneId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const canEdit = useCan('member');
  const accounts = useQuery(dnsAccountsQuery);
  const zones = useQuery(zonesQuery);
  const providers = useQuery(providersQuery);
  const sync = useApiMutation(syncDnsAccount, {
    invalidate: [keys.dns],
    success: 'Zones synchronized',
  });

  if (accounts.isPending || zones.isPending) return <ListSkeleton rows={4} />;
  if (accounts.isError) return <ErrorAlert error={accounts.error} />;
  if (zones.isError) return <ErrorAlert error={zones.error} />;
  if (accounts.data.items.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title="No DNS provider accounts"
        description="Connect a DNS provider so Launchway can create records for your domains."
        action={
          <Button asChild size="sm">
            <Link to="/settings" search={{ tab: 'dns' }}>
              Add a provider account
            </Link>
          </Button>
        }
      />
    );
  }

  const zoneList = zones.data.items;
  const selected = zoneList.find((zone) => zone.id === selectedZoneId) ?? zoneList[0];
  const capabilities = new Map((providers.data?.items ?? []).map((p) => [p.kind, p.capabilities]));
  const accountKind = new Map(accounts.data.items.map((account) => [account.id, account.kind]));

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <div className="flex flex-col gap-4">
        {accounts.data.items.map((account) => (
          <Card key={account.id} size="sm">
            <CardHeader>
              <CardTitle className="text-sm">{account.name}</CardTitle>
              <CardDescription className="text-xs">{account.kind}</CardDescription>
              {canEdit && (
                <CardAction>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Synchronize zones of ${account.name}`}
                    onClick={() => sync.mutate(account.id)}
                    disabled={sync.isPending}
                  >
                    <RefreshCw className={cn(sync.isPending && 'animate-spin')} />
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1" aria-label={`Zones of ${account.name}`}>
                {zoneList
                  .filter((zone) => zone.accountId === account.id)
                  .map((zone) => (
                    <li key={zone.id}>
                      <button
                        type="button"
                        aria-current={zone.id === selected?.id ? 'true' : undefined}
                        onClick={() => void navigate({ search: { tab: 'zones', zone: zone.id } })}
                        className={cn(
                          'w-full rounded-md px-2 py-1.5 text-left font-mono text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                          zone.id === selected?.id && 'bg-muted font-medium',
                        )}
                      >
                        {zone.name}
                      </button>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
      <div>
        {selected ? (
          <RecordsPanel
            key={selected.id}
            zone={selected}
            proxiedSupported={
              capabilities.get(accountKind.get(selected.accountId) ?? '')?.proxied ?? false
            }
          />
        ) : (
          <EmptyState
            title="No zones"
            description="Synchronize an account to discover its zones."
          />
        )}
      </div>
    </div>
  );
}

const OUTCOME_TONES = {
  unchanged: 'success',
  updated: 'info',
  skipped: 'warning',
  failed: 'danger',
} as const;

function DdnsCard() {
  const canRun = useCan('admin');
  const ddns = useQuery(ddnsQuery);
  const run = useApiMutation(runDdns, {
    invalidate: [keys.dns, keys.settings],
    success: (result) => result.message,
  });
  const lastRun = ddns.data?.lastRun;
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wifi className="size-4" aria-hidden="true" /> Dynamic DNS
        </CardTitle>
        <CardDescription>
          Launchway checks the public IPv4 every 5 minutes and keeps the anchor record pointed at
          it. Managed app domains are CNAMEs to the anchor.
        </CardDescription>
        {canRun && (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => run.mutate()}
              disabled={run.isPending}
            >
              {run.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Run now
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {ddns.isPending ? (
          <ListSkeleton rows={3} />
        ) : ddns.isError ? (
          <ErrorAlert error={ddns.error} />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {ddns.data.dynamicDnsEnabled ? (
                <StatusBadge tone="success">enabled</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">disabled</StatusBadge>
              )}
            </dd>
            <dt className="text-muted-foreground">Public IPv4</dt>
            <dd className="font-mono" data-testid="public-ipv4">
              {ddns.data.publicIpv4 ?? 'unknown'}
            </dd>
            <dt className="text-muted-foreground">Anchor</dt>
            <dd>
              <span className="font-mono">{ddns.data.anchorHostname ?? 'not set'}</span>
              {ddns.data.anchorHostname && !ddns.data.anchorZoneId && (
                <span className="ml-2 text-xs text-muted-foreground">not in a managed zone</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Last check</dt>
            <dd>{formatRelative(ddns.data.publicIpv4CheckedAt)}</dd>
            {lastRun && (
              <>
                <dt className="text-muted-foreground">Last run</dt>
                <dd className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <StatusBadge tone={OUTCOME_TONES[lastRun.outcome]}>
                      {lastRun.outcome}
                    </StatusBadge>
                    {formatRelative(lastRun.startedAt)}
                  </span>
                  <span className="text-xs text-muted-foreground">{lastRun.message}</span>
                </dd>
              </>
            )}
          </dl>
        )}
        {canRun && (
          <p className="mt-4 text-xs text-muted-foreground">
            Change the anchor and switch dynamic DNS on or off in{' '}
            <Link
              to="/settings"
              search={{ tab: 'platform' }}
              className="underline underline-offset-4"
            >
              platform settings
            </Link>
            .
          </p>
        )}
      </CardContent>
    </Card>
  );
}
