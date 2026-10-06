import {
  DNS_RECORD_TYPES,
  type DnsRecord,
  DnsRecordInput,
  type DnsRecordType,
  type DnsZone,
} from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { createRecord, deleteRecord, recordsQuery, updateRecord } from '@/api/domains';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { ConfirmButton } from '@/components/confirm-button';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCan } from '@/hooks/use-me';

/** Records of one zone, with add / edit / delete for members. */
export function RecordsPanel({
  zone,
  proxiedSupported,
}: {
  zone: DnsZone;
  proxiedSupported: boolean;
}) {
  const canEdit = useCan('member');
  const records = useQuery(recordsQuery(zone.id));
  const remove = useApiMutation((record: DnsRecord) => deleteRecord(zone.id, record.externalId), {
    invalidate: [[...keys.dns, 'records', zone.id]],
    success: (_, record) => `${record.type} ${record.name} deleted`,
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">
          Records of <span className="font-mono">{zone.name}</span>
        </h3>
        {canEdit && <RecordDialog zone={zone} proxiedSupported={proxiedSupported} />}
      </div>
      {records.isPending ? (
        <ListSkeleton rows={4} />
      ) : records.isError ? (
        <ErrorAlert error={records.error} onRetry={() => void records.refetch()} />
      ) : records.data.items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          This zone has no A, AAAA, CNAME or TXT records.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Content</TableHead>
                <TableHead className="hidden sm:table-cell">TTL</TableHead>
                {proxiedSupported && (
                  <TableHead className="hidden sm:table-cell">Proxied</TableHead>
                )}
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.data.items.map((record) => (
                <TableRow key={record.externalId}>
                  <TableCell className="font-mono text-xs">{record.type}</TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs">
                    {record.name}
                  </TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={record.content}>
                    {record.content}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {record.ttl === 1 ? 'auto' : (record.ttl ?? '—')}
                  </TableCell>
                  {proxiedSupported && (
                    <TableCell className="hidden sm:table-cell">
                      {record.proxied ? 'yes' : 'no'}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <RecordDialog
                          zone={zone}
                          record={record}
                          proxiedSupported={proxiedSupported}
                        />
                        <ConfirmButton
                          title={`Delete ${record.type} ${record.name}?`}
                          description="The record is removed at the DNS provider right away."
                          confirmLabel="Delete record"
                          onConfirm={() => remove.mutate(record)}
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${record.type} ${record.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </ConfirmButton>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function RecordDialog({
  zone,
  record,
  proxiedSupported,
}: {
  zone: DnsZone;
  record?: DnsRecord;
  proxiedSupported: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<DnsRecordType>(record?.type ?? 'A');
  const [name, setName] = useState(record?.name ?? zone.name);
  const [content, setContent] = useState(record?.content ?? '');
  const [ttl, setTtl] = useState(record?.ttl ? String(record.ttl) : '1');
  const [proxied, setProxied] = useState(record?.proxied ?? false);
  const input = DnsRecordInput.safeParse({
    type,
    name,
    content,
    ttl: Number(ttl),
    ...(proxiedSupported ? { proxied } : {}),
  });
  const issue = (field: string) =>
    input.error?.issues.find((item) => item.path[0] === field)?.message;
  const save = useApiMutation(
    () => {
      if (!input.success) return Promise.reject(input.error);
      return record
        ? updateRecord(zone.id, record.externalId, input.data)
        : createRecord(zone.id, input.data);
    },
    {
      invalidate: [[...keys.dns, 'records', zone.id]],
      success: record ? 'Record updated' : 'Record created',
      onSuccess: () => setOpen(false),
    },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {record ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${record.type} ${record.name}`}>
            <Pencil />
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> Add record
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record ? 'Edit record' : 'Add record'}</DialogTitle>
          <DialogDescription>
            In zone <span className="font-mono">{zone.name}</span>
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid grid-cols-[7rem_1fr] gap-4">
            <Field label="Type">
              <Select value={type} onValueChange={(value) => setType(value as DnsRecordType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DNS_RECORD_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Name" error={name === '' ? undefined : issue('name')}>
              <Input
                className="font-mono"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Content" error={content === '' ? undefined : issue('content')}>
            <Input
              className="font-mono"
              value={content}
              placeholder={
                type === 'A' ? '203.0.113.10' : type === 'CNAME' ? 'home.example.com' : ''
              }
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 items-end gap-4">
            <Field label="TTL (seconds, 1 = automatic)" error={issue('ttl')}>
              <Input
                inputMode="numeric"
                value={ttl}
                onChange={(event) => setTtl(event.target.value)}
              />
            </Field>
            {proxiedSupported && (
              <div className="flex h-8 items-center gap-2">
                <Switch id="record-proxied" checked={proxied} onCheckedChange={setProxied} />
                <Label htmlFor="record-proxied">Proxied</Label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!input.success || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Save record
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
