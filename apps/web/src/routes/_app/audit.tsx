import type { AuditEvent } from '@slipway/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronDown, Loader2, ScrollText, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import { auditQuery } from '@/api/users';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const TARGET_TYPES = [
  'app',
  'deployment',
  'env',
  'domain',
  'route',
  'dns',
  'node',
  'github',
  'settings',
  'user',
  'invitation',
  'token',
] as const;

interface AuditSearch {
  action?: string;
  targetType?: string;
  actorId?: string;
  targetId?: string;
}

const ALL = '__all__';

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 100) : undefined;
}

function withoutEmpty(search: { [K in keyof AuditSearch]?: string | undefined }): AuditSearch {
  const result: AuditSearch = {};
  for (const [key, value] of Object.entries(search)) {
    if (value) result[key as keyof AuditSearch] = value;
  }
  return result;
}

export const Route = createFileRoute('/_app/audit')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => {
    const result: AuditSearch = {};
    for (const key of ['action', 'targetType', 'actorId', 'targetId'] as const) {
      const value = stringParam(search[key]);
      if (value) result[key] = value;
    }
    return result;
  },
  component: AuditLog,
});

function AuditLog() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [action, setAction] = useState(search.action ?? '');
  const debouncedAction = useDebouncedValue(action.trim(), 400);
  const filters = { ...search, action: debouncedAction || undefined };
  const events = useInfiniteQuery(auditQuery(filters));
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);

  const setFilter = (patch: { [K in keyof AuditSearch]?: string | undefined }) =>
    void navigate({ search: (previous) => withoutEmpty({ ...previous, ...patch }), replace: true });
  const hasFilters = Boolean(search.targetType || search.actorId || search.targetId || action);

  return (
    <Page>
      <PageHeader title="Audit log" description="Every change, who made it and from where." />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          aria-label="Filter by action"
          placeholder="Action, e.g. app.create"
          className="sm:max-w-64"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          onBlur={() => setFilter({ action: action.trim() })}
        />
        <Select
          value={search.targetType ?? ALL}
          onValueChange={(value) =>
            setFilter({ targetType: value === ALL ? undefined : value, targetId: undefined })
          }
        >
          <SelectTrigger className="sm:w-44" aria-label="Filter by target type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All targets</SelectItem>
            {TARGET_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button
            variant="ghost"
            onClick={() => {
              setAction('');
              void navigate({ search: {}, replace: true });
            }}
          >
            <X /> Clear filters
          </Button>
        )}
      </div>
      {events.isPending ? (
        <ListSkeleton rows={8} />
      ) : events.isError ? (
        <ErrorAlert error={events.error} onRetry={() => void events.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No events"
          description={hasFilters ? 'Nothing matches the filters.' : 'Nothing has changed yet.'}
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden md:table-cell">Target</TableHead>
                <TableHead className="hidden lg:table-cell">From</TableHead>
                <TableHead>
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((event) => (
                <AuditRow
                  key={event.id}
                  event={event}
                  expanded={expanded === event.id}
                  onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
                  onFilterActor={(actorId) => setFilter({ actorId })}
                  onFilterTarget={(targetType, targetId) => setFilter({ targetType, targetId })}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {events.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void events.fetchNextPage()}
          disabled={events.isFetchingNextPage}
        >
          {events.isFetchingNextPage && <Loader2 className="animate-spin" />}
          Load older events
        </Button>
      )}
    </Page>
  );
}

function AuditRow({
  event,
  expanded,
  onToggle,
  onFilterActor,
  onFilterTarget,
}: {
  event: AuditEvent;
  expanded: boolean;
  onToggle: () => void;
  onFilterActor: (actorId: string) => void;
  onFilterTarget: (type: string, id: string) => void;
}) {
  const actorId = event.actor.id;
  const target = event.target;
  return (
    <Fragment>
      <TableRow>
        <TableCell className="whitespace-nowrap" title={formatDateTime(event.createdAt)}>
          {formatRelative(event.createdAt)}
        </TableCell>
        <TableCell>
          {actorId ? (
            <button
              type="button"
              className="text-left hover:underline"
              onClick={() => onFilterActor(actorId)}
            >
              {event.actor.label ?? actorId}
            </button>
          ) : (
            (event.actor.label ?? event.actor.type)
          )}
          <div className="text-xs text-muted-foreground">{event.actor.type}</div>
        </TableCell>
        <TableCell className="font-mono text-xs">{event.action}</TableCell>
        <TableCell className="hidden font-mono text-xs md:table-cell">
          {target ? (
            target.id ? (
              <button
                type="button"
                className="hover:underline"
                onClick={() => onFilterTarget(target.type, target.id ?? '')}
              >
                {target.type}:{target.id}
              </button>
            ) : (
              target.type
            )
          ) : (
            '—'
          )}
        </TableCell>
        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
          {event.ipAddress ?? '—'}
        </TableCell>
        <TableCell className="text-right">
          {event.summary && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide details' : 'Show details'}
              onClick={onToggle}
            >
              <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
            </Button>
          )}
        </TableCell>
      </TableRow>
      {expanded && event.summary && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/40">
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(event.summary, null, 2)}
            </pre>
            {event.userAgent && (
              <p className="mt-2 text-xs text-muted-foreground">{event.userAgent}</p>
            )}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
