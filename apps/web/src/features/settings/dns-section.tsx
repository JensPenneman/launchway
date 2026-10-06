import { DisplayName, type DnsProviderInfo } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2, Network, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  createDnsAccount,
  deleteDnsAccount,
  dnsAccountsQuery,
  providersQuery,
  syncDnsAccount,
  zonesQuery,
} from '@/api/domains';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
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
import { fieldsToCredentials, type SchemaField, schemaToFields } from '@/lib/json-schema-form';

export function DnsSection() {
  const accounts = useQuery(dnsAccountsQuery);
  const zones = useQuery(zonesQuery);
  const providers = useQuery(providersQuery);
  const remove = useApiMutation(deleteDnsAccount, {
    invalidate: [keys.dns, keys.domains],
    success: 'Provider account removed',
  });
  const sync = useApiMutation(syncDnsAccount, {
    invalidate: [keys.dns],
    success: 'Zones synchronized',
  });
  const labels = new Map(
    (providers.data?.items ?? []).map((provider) => [provider.kind, provider.label]),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-muted-foreground">
          Credentials are encrypted at rest and never shown again.
        </p>
        <AddAccountDialog providers={providers.data?.items ?? []} />
      </div>
      {accounts.isPending ? (
        <ListSkeleton rows={2} />
      ) : accounts.isError ? (
        <ErrorAlert error={accounts.error} />
      ) : accounts.data.items.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No DNS provider accounts"
          description="Add one so Slipway can manage the records of your domains and the dynamic DNS anchor."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="DNS provider accounts">
          {accounts.data.items.map((account) => {
            const zoneNames = (zones.data?.items ?? [])
              .filter((zone) => zone.accountId === account.id)
              .map((zone) => zone.name);
            return (
              <li key={account.id}>
                <Card size="sm">
                  <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {account.name}{' '}
                        <span className="text-sm font-normal text-muted-foreground">
                          {labels.get(account.kind) ?? account.kind}
                        </span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {zoneNames.length > 0 ? zoneNames.join(', ') : 'no zones'} · verified{' '}
                        {formatRelative(account.lastVerifiedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sync.mutate(account.id)}
                        disabled={sync.isPending}
                      >
                        <RefreshCw /> Sync zones
                      </Button>
                      <ConfirmButton
                        title={`Remove ${account.name}?`}
                        description="Its zones are forgotten; domains in them become unmanaged. Records at the provider stay."
                        confirmLabel="Remove account"
                        onConfirm={() => remove.mutate(account.id)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${account.name}`}
                        >
                          <Trash2 />
                        </Button>
                      </ConfirmButton>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CredentialField({
  field,
  value,
  onChange,
}: {
  field: SchemaField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const label = `${field.label}${field.required ? '' : ' (optional)'}`;
  if (field.kind === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div>
          <label htmlFor={`cred-${field.name}`} className="text-sm font-medium">
            {field.label}
          </label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
        </div>
        <Switch id={`cred-${field.name}`} checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  }
  if (field.kind === 'enum') {
    return (
      <Field label={label} description={field.description ?? undefined}>
        <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }
  return (
    <Field label={label} description={field.description ?? undefined}>
      <Input
        type={field.kind === 'secret' ? 'password' : 'text'}
        inputMode={field.kind === 'number' ? 'numeric' : undefined}
        autoComplete="off"
        className={field.kind === 'secret' ? 'font-mono' : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function initialValues(fields: readonly SchemaField[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (field.defaultValue !== null) {
      values[field.name] =
        typeof field.defaultValue === 'number' ? String(field.defaultValue) : field.defaultValue;
    }
  }
  return values;
}

function AddAccountDialog({ providers }: { providers: readonly DnsProviderInfo[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const provider = providers.find((item) => item.kind === kind);
  const fields = provider ? schemaToFields(provider.credentialsSchema) : [];
  const create = useApiMutation(
    () =>
      createDnsAccount({
        kind,
        name: name.trim(),
        credentials: fieldsToCredentials(fields, values),
      }),
    {
      invalidate: [keys.dns],
      success: (account) => `${account.name} added; zones are being discovered`,
      onSuccess: () => setOpen(false),
    },
  );
  const missing = fields.some(
    (field) => field.required && field.kind !== 'boolean' && !values[field.name],
  );
  const nameError = name === '' ? undefined : fieldError(DisplayName, name);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setKind('');
          setName('');
          setValues({});
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add provider account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a DNS provider account</DialogTitle>
          <DialogDescription>
            Slipway verifies the credentials and discovers the zones.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Provider">
            <Select
              value={kind}
              onValueChange={(next) => {
                setKind(next);
                const info = providers.find((item) => item.kind === next);
                setValues(initialValues(info ? schemaToFields(info.credentialsSchema) : []));
                if (!name && info) setName(info.label);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((item) => (
                  <SelectItem key={item.kind} value={item.kind}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {provider && (
            <>
              <Field label="Name" error={nameError}>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              {fields.map((field) => (
                <CredentialField
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  onChange={(value) =>
                    setValues((current) => ({ ...current, [field.name]: value }))
                  }
                />
              ))}
              {provider.docsUrl && (
                <a
                  href={provider.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
                >
                  How to create these credentials <ExternalLink className="size-3" />
                </a>
              )}
            </>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                !provider ||
                name.trim() === '' ||
                nameError !== undefined ||
                missing ||
                create.isPending
              }
            >
              {create.isPending && <Loader2 className="animate-spin" />}
              Add account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
