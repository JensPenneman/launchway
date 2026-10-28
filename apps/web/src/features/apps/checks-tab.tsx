import {
  type App,
  CHECK_RUN_STATUSES,
  type CheckRun,
  type CheckRunStatus,
  type CreateCheckRunsInput,
  checkStatusContext,
  GitRef,
  githubStateOfCheck,
  isActiveCheckRunStatus,
} from '@launchway/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ListChecks, Loader2, Play, RotateCw, Settings2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  type CheckRunFilters,
  cancelCheckRun,
  checkRunQuery,
  checkRunsQuery,
  createCheckRuns,
  rerunCheckRun,
} from '@/api/checks';
import { useCheckLogStream } from '@/api/events';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodesQuery } from '@/api/nodes';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { LogViewer, type LogViewerLine } from '@/components/log-viewer';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { CheckRunStatusBadge, GitHubStateBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCan } from '@/hooks/use-me';
import { fieldError } from '@/lib/form';
import { formatDateTime, formatDuration, shortSha } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  CHECK_TRIGGER_LABELS,
  checkLogEmptyText,
  checkRunOutcome,
  checkRunQueueLabel,
  checkRunStartedLabel,
} from './check-runs';

const ALL = '__all__';

interface ChecksTabProps {
  app: App;
  /** Run shown in the drawer (`?check=<id>`). */
  openRunId: string | null;
  onOpenRun: (id: string | null) => void;
  /** Opens the app settings, where the checks are configured (members only). */
  onConfigure?: (() => void) | undefined;
}

const repositoryUrl = (app: App) =>
  `https://github.com/${app.repository.owner}/${app.repository.name}`;

/** Check runs of an app: the configured test commands per commit, with their logs. */
export function ChecksTab({ app, openRunId, onOpenRun, onConfigure }: ChecksTabProps) {
  const canRun = useCan('member');
  const [name, setName] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const filters: CheckRunFilters = {
    ...(name === ALL ? {} : { name }),
    ...(status === ALL ? {} : { status: status as CheckRunStatus }),
  };
  const filtered = name !== ALL || status !== ALL;
  const runs = useInfiniteQuery(checkRunsQuery(app.id, filters));
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const configured = app.checks.items.map((item) => item.name);
  const nameOptions = [
    ...new Set([...configured, ...items.map((run) => run.name), ...(filtered ? [name] : [])]),
  ].filter((option) => option !== ALL);
  const clearFilters = () => {
    setName(ALL);
    setStatus(ALL);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-sm text-muted-foreground">
          Checks run the app's test commands for a commit and report each result to GitHub as a
          commit status <code className="font-mono">launchway/&lt;name&gt;</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {(items.length > 0 || filtered) && (
            <>
              <Select value={name} onValueChange={setName}>
                <SelectTrigger size="sm" aria-label="Filter by check" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All checks</SelectItem>
                  {nameOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger size="sm" aria-label="Filter by status" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any status</SelectItem>
                  {CHECK_RUN_STATUSES.map((option) => (
                    <SelectItem key={option} value={option} className="capitalize">
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {canRun && configured.length > 0 && (
            <RunChecksDialog
              app={app}
              onCreated={(created) => {
                clearFilters();
                if (created.length === 1 && created[0]) onOpenRun(created[0].id);
              }}
            />
          )}
        </div>
      </div>
      {configured.length > 0 && !app.checks.enabled && (
        <Alert>
          <ListChecks />
          <AlertDescription>
            Pushes and pull requests do not run the checks: they are turned off in the app settings.
            {canRun && ' Running them by hand works.'}
          </AlertDescription>
        </Alert>
      )}
      {configured.length === 0 && items.length > 0 && (
        <Alert>
          <ListChecks />
          <AlertDescription>
            No checks are configured any more; their earlier runs stay listed.
          </AlertDescription>
        </Alert>
      )}
      {runs.isPending ? (
        <ListSkeleton rows={5} />
      ) : runs.isError ? (
        <ErrorAlert error={runs.error} onRetry={() => void runs.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={ListChecks}
            title="No runs match these filters"
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Show all runs
              </Button>
            }
          />
        ) : configured.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No checks configured"
            description={
              canRun
                ? "Add the app's test commands, such as linters and unit tests, in the Checks card of its settings. Pushes and pull requests then run them, and you can run them by hand."
                : "A member can add the app's test commands in the Checks card of its settings."
            }
            action={
              canRun && onConfigure ? (
                <Button variant="outline" onClick={onConfigure}>
                  <Settings2 /> Configure checks
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            icon={ListChecks}
            title="No check runs yet"
            description={[
              app.checks.enabled && 'Pushes and pull requests run the checks.',
              canRun && 'Run checks starts them for a branch, tag or commit.',
            ]
              .filter(Boolean)
              .join(' ')}
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Check</TableHead>
                <TableHead className="hidden sm:table-cell">Commit</TableHead>
                <TableHead className="hidden md:table-cell">Trigger</TableHead>
                <TableHead className="hidden lg:table-cell">Duration</TableHead>
                <TableHead className="hidden md:table-cell">Started</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((run) => (
                <CheckRunRow
                  key={run.id}
                  app={app}
                  run={run}
                  canRun={canRun}
                  configured={configured.includes(run.name)}
                  onOpenRun={onOpenRun}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {runs.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void runs.fetchNextPage()}
          disabled={runs.isFetchingNextPage}
        >
          {runs.isFetchingNextPage && <Loader2 className="animate-spin" />}
          Load more
        </Button>
      )}
      <CheckRunDrawer
        runId={openRunId}
        app={app}
        onOpenRun={onOpenRun}
        onClose={() => onOpenRun(null)}
      />
    </div>
  );
}

/** A queued run is cancelled at once; a running one once its node has stopped it. */
const cancelledMessage = (run: CheckRun) =>
  run.status === 'cancelled' ? `${run.name} cancelled` : `Cancelling ${run.name}`;

/** Commit of a run with its branch, or the pull request it belongs to. */
function CommitCell({ app, run }: { app: App; run: CheckRun }) {
  return (
    <div className="flex flex-col gap-0.5">
      <a
        href={`${repositoryUrl(app)}/commit/${run.commitSha}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs hover:underline"
      >
        {shortSha(run.commitSha)}
      </a>
      <span className="max-w-56 truncate text-xs text-muted-foreground">
        {run.prNumber !== null && (
          <a
            href={`${repositoryUrl(app)}/pull/${run.prNumber}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            PR #{run.prNumber}
          </a>
        )}
        {run.prNumber !== null && run.ref && ' · '}
        {run.ref && <span className="font-mono">{run.ref}</span>}
        {run.alsoRef && (
          <span title={`The push of this commit to ${run.alsoRef} uses this run too`}>
            {' · also '}
            <span className="font-mono">{run.alsoRef}</span>
          </span>
        )}
      </span>
    </div>
  );
}

/** Under a run's status: its place in the node's queue, or the run whose result it reused. */
function RunNote({ run, onOpenRun }: { run: CheckRun; onOpenRun: (id: string) => void }) {
  const queue = checkRunQueueLabel(run);
  if (queue) return <span className="text-xs text-muted-foreground">{queue}</span>;
  if (run.reason !== 'same-tree' || run.copiedFrom === null) return null;
  const copiedFrom = run.copiedFrom;
  return (
    <button
      type="button"
      className="text-left text-xs text-muted-foreground hover:underline"
      onClick={() => onOpenRun(copiedFrom)}
    >
      same tree, result reused
    </button>
  );
}

function CheckRunRow({
  app,
  run,
  canRun,
  configured,
  onOpenRun,
}: {
  app: App;
  run: CheckRun;
  canRun: boolean;
  /** The check still exists in the app settings, so it can run again. */
  configured: boolean;
  onOpenRun: (id: string) => void;
}) {
  const active = isActiveCheckRunStatus(run.status);
  const cancel = useApiMutation(() => cancelCheckRun(run.id), {
    invalidate: [keys.checks],
    success: cancelledMessage,
  });
  const rerun = useApiMutation(() => rerunCheckRun(run.id), {
    invalidate: [keys.checks],
    success: (created) => `Re-running ${created.name} on ${shortSha(created.commitSha)}`,
  });

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <CheckRunStatusBadge status={run.status} />
          <RunNote run={run} onOpenRun={onOpenRun} />
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{run.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {checkStatusContext(run.name)}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <CommitCell app={app} run={run} />
      </TableCell>
      <TableCell className="hidden md:table-cell">{CHECK_TRIGGER_LABELS[run.trigger]}</TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">
        {formatDuration(run.startedAt, run.finishedAt)}
      </TableCell>
      <TableCell
        className="hidden text-muted-foreground md:table-cell"
        title={formatDateTime(run.startedAt ?? run.createdAt)}
      >
        {checkRunStartedLabel(run)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {canRun && active && (
            <ConfirmButton
              title={`Cancel ${run.name}?`}
              description={`The run on ${shortSha(run.commitSha)} stops, and GitHub shows ${checkStatusContext(run.name)} as an error until the check runs again.`}
              confirmLabel="Cancel check"
              onConfirm={() => cancel.mutate()}
            >
              <Button variant="ghost" size="sm" disabled={cancel.isPending}>
                {cancel.isPending ? <Loader2 className="animate-spin" /> : <Ban />}
                <span className="sr-only sm:not-sr-only">Cancel</span>
              </Button>
            </ConfirmButton>
          )}
          {canRun && !active && configured && (
            <Button
              variant="ghost"
              size="sm"
              disabled={rerun.isPending}
              onClick={() => rerun.mutate()}
            >
              {rerun.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
              <span className="sr-only sm:not-sr-only">Re-run</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenRun(run.id)}>
            Logs
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function RunChecksDialog({
  app,
  onCreated,
}: {
  app: App;
  onCreated: (runs: readonly CheckRun[]) => void;
}) {
  const all = app.checks.items.map((item) => item.name);
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [selected, setSelected] = useState<readonly string[]>(all);
  const value = ref.trim();
  const refError = value === '' ? undefined : fieldError(GitRef, value);
  const names = all.filter((name) => selected.includes(name));
  const run = useApiMutation((input: CreateCheckRunsInput) => createCheckRuns(app.id, input), {
    invalidate: [keys.checks],
    success: (result, input) =>
      result.items.length === 1
        ? `Queued ${result.items[0]?.name ?? 'the check'} for ${input.ref}`
        : `Queued ${result.items.length} checks for ${input.ref}`,
    onSuccess: (result) => {
      setOpen(false);
      onCreated(result.items);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Every configured check is selected again when the dialog opens.
        if (next) setSelected(all);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Play /> Run checks
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run the checks of {app.name}</DialogTitle>
          <DialogDescription>
            Each check runs once for the commit the ref points to, and GitHub shows the result on
            that commit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (value === '' || refError || names.length === 0) return;
            run.mutate({ ref: value, ...(names.length === all.length ? {} : { names }) });
          }}
        >
          <Field
            label="Branch, tag or commit"
            error={refError}
            description="Resolved to a commit; checks that already run for it are skipped."
          >
            <Input
              className="font-mono"
              placeholder="main"
              autoComplete="off"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Checks</legend>
            {app.checks.items.map((item) => (
              <div key={item.name} className="flex items-start gap-2">
                <Checkbox
                  id={`run-check-${item.name}`}
                  checked={selected.includes(item.name)}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked === true
                        ? [...current, item.name]
                        : current.filter((name) => name !== item.name),
                    )
                  }
                />
                <div className="grid min-w-0 gap-0.5">
                  <Label htmlFor={`run-check-${item.name}`} className="font-mono">
                    {item.name}
                  </Label>
                  <p className="truncate font-mono text-xs text-muted-foreground">{item.command}</p>
                </div>
              </div>
            ))}
            {names.length === 0 && (
              <p className="text-xs text-destructive">Choose at least one check.</p>
            )}
          </fieldset>
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                value === '' || refError !== undefined || names.length === 0 || run.isPending
              }
            >
              {run.isPending && <Loader2 className="animate-spin" />}
              {names.length === 1 ? `Run ${names[0]}` : `Run ${names.length} checks`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CheckRunDrawer({
  runId,
  app,
  onOpenRun,
  onClose,
}: {
  runId: string | null;
  app: App;
  onOpenRun: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={runId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        {runId && <CheckRunDetail key={runId} runId={runId} app={app} onOpenRun={onOpenRun} />}
      </SheetContent>
    </Sheet>
  );
}

function Detail({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function CheckRunDetail({
  runId,
  app,
  onOpenRun,
}: {
  runId: string;
  app: App;
  onOpenRun: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const canRun = useCan('member');
  const run = useQuery(checkRunQuery(runId));
  const nodes = useQuery(nodesQuery);
  const stream = useCheckLogStream(runId);
  const cancel = useApiMutation(() => cancelCheckRun(runId), {
    invalidate: [keys.checks],
    success: cancelledMessage,
  });
  const rerun = useApiMutation(() => rerunCheckRun(runId), {
    invalidate: [keys.checks],
    success: (created) => `Re-running ${created.name} on ${shortSha(created.commitSha)}`,
    onSuccess: (created) => onOpenRun(created.id),
  });

  // Status changes in the stream refresh the run (exit code, GitHub state) and the run lists.
  useEffect(() => {
    if (stream.status || stream.state === 'ended') {
      void queryClient.invalidateQueries({ queryKey: keys.checks });
    }
  }, [stream.status, stream.state, queryClient]);

  const data = run.data;
  const status = stream.status ?? data?.status;
  const active = status !== undefined && isActiveCheckRunStatus(status);
  const outcome = data ? checkRunOutcome(data) : null;
  const node = nodes.data?.items.find((item) => item.id === data?.nodeId);
  const configured = data !== undefined && app.checks.items.some((item) => item.name === data.name);
  const lines: LogViewerLine[] = stream.lines.map((line) => ({
    key: line.seq,
    text: line.line,
    tone: line.stream === 'stderr' ? 'error' : line.stream === 'system' ? 'system' : 'default',
  }));

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle className="flex items-center gap-2 pr-8">
          Check <span className="font-mono">{data?.name ?? ''}</span>
          {status && <CheckRunStatusBadge status={status} />}
        </SheetTitle>
        <SheetDescription>
          {data
            ? `${checkStatusContext(data.name)} · ${shortSha(data.commitSha)}${data.ref ? ` on ${data.ref}` : ''} · ${CHECK_TRIGGER_LABELS[data.trigger]} · queued ${formatDateTime(data.createdAt)}`
            : 'Loading…'}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {run.isError && <ErrorAlert error={run.error} />}
        {data?.statusMessage && (
          <p
            className={cn(
              'rounded-lg border p-3 text-sm',
              (status === 'failed' || status === 'errored') &&
                'border-destructive/40 text-destructive',
            )}
          >
            {data.statusMessage}
          </p>
        )}
        {data && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Detail label="Command" className="col-span-full">
              <pre className="rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                {data.command}
              </pre>
            </Detail>
            <Detail label="Service">
              <span className="font-mono">{data.service}</span>
            </Detail>
            <Detail label="Compose files">
              <span className="font-mono">{data.composeFiles.join(', ')}</span>
            </Detail>
            <Detail label="Timeout">
              {data.timeoutMinutes} {data.timeoutMinutes === 1 ? 'minute' : 'minutes'}
            </Detail>
            <Detail label="Commit">
              <CommitCell app={app} run={data} />
            </Detail>
            <Detail label="Node">{node?.name ?? data.nodeId}</Detail>
            <Detail label="Duration">{formatDuration(data.startedAt, data.finishedAt)}</Detail>
            <Detail label="Result" className="col-span-2">
              {outcome ??
                (data.status === 'queued'
                  ? `Waiting for its node${checkRunQueueLabel(data) ? `: ${checkRunQueueLabel(data)}` : ''}`
                  : 'Running')}
            </Detail>
            <Detail label="Exit code">
              <span className="font-mono">{data.exitCode ?? '—'}</span>
            </Detail>
            {data.reason === 'same-tree' && data.copiedFrom && (
              <Detail label="Result of" className="col-span-2">
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => data.copiedFrom && onOpenRun(data.copiedFrom)}
                >
                  The run of the same tree
                </Button>
              </Detail>
            )}
            {data.treeSha && (
              <Detail label="Tree">
                <span className="font-mono" title={data.treeSha}>
                  {shortSha(data.treeSha)}
                </span>
              </Detail>
            )}
            <Detail label="On GitHub" className="col-span-full">
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono">{checkStatusContext(data.name)}</code>
                {data.githubState ? (
                  <GitHubStateBadge state={data.githubState} />
                ) : (
                  <span className="text-muted-foreground">not reported</span>
                )}
                {!isActiveCheckRunStatus(data.status) &&
                  data.githubState !== githubStateOfCheck(data.status) && (
                    <span className="text-xs text-muted-foreground">
                      GitHub has not received the final state ({githubStateOfCheck(data.status)}).
                    </span>
                  )}
              </span>
            </Detail>
          </dl>
        )}
        <LogViewer
          lines={lines}
          state={stream.state}
          filename={`${app.slug}-${data?.name ?? 'check'}-${data ? shortSha(data.commitSha) : runId}.log`}
          {...(status ? { emptyText: checkLogEmptyText(status, data?.reason) } : {})}
          className="min-h-80 flex-1"
        />
        {canRun && status && (
          <div className="flex flex-wrap gap-2">
            {active ? (
              <Button
                variant="destructive"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <Ban /> Cancel check
              </Button>
            ) : (
              configured && (
                <Button variant="outline" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
                  {rerun.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  Re-run
                </Button>
              )
            )}
          </div>
        )}
      </div>
    </>
  );
}
