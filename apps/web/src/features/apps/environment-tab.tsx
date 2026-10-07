import { type App, EnvKey, type EnvVar } from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { ClipboardPaste, EyeOff, Loader2, Pencil, Plus, Trash2, Variable } from 'lucide-react';
import { useState } from 'react';
import { deleteEnvVar, envQuery, putEnvVar, setEnvVars } from '@/api/apps';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useCan } from '@/hooks/use-me';
import { parseDotenv } from '@/lib/dotenv';
import { fieldError } from '@/lib/form';
import { mergeEnvForBulk } from './env-merge';

export function EnvironmentTab({ app }: { app: App }) {
  const canEdit = useCan('member');
  const env = useQuery(envQuery(app.id));
  const remove = useApiMutation((key: string) => deleteEnvVar(app.id, key), {
    invalidate: [keys.env],
    success: (_, key) => `${key} removed`,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-muted-foreground">
          Written to the app's <code>.env</code> on the next deployment. Secret values are encrypted
          and never shown again.
        </p>
        {canEdit && env.data && (
          <div className="flex gap-2">
            <BulkPasteDialog app={app} existing={env.data.items} />
            <EnvVarDialog app={app} />
          </div>
        )}
      </div>
      {env.isPending ? (
        <ListSkeleton rows={4} />
      ) : env.isError ? (
        <ErrorAlert error={env.error} onRetry={() => void env.refetch()} />
      ) : env.data.items.length === 0 ? (
        <EmptyState
          icon={Variable}
          title="No environment variables"
          description="Add variables one by one or paste the contents of a .env file."
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {env.data.items.map((variable) => (
                <TableRow key={variable.key}>
                  <TableCell className="font-mono text-sm">{variable.key}</TableCell>
                  <TableCell className="max-w-xs">
                    {variable.secret ? (
                      <StatusBadge tone="neutral">secret</StatusBadge>
                    ) : (
                      <span
                        className="block truncate font-mono text-xs"
                        title={variable.value ?? ''}
                      >
                        {variable.value === '' ? (
                          <em className="text-muted-foreground">empty</em>
                        ) : (
                          variable.value
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <EnvVarDialog app={app} variable={variable} />
                        <ConfirmButton
                          title={`Remove ${variable.key}?`}
                          description="The variable disappears from the next deployment."
                          confirmLabel="Remove"
                          onConfirm={() => remove.mutate(variable.key)}
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${variable.key}`}
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

function EnvVarDialog({ app, variable }: { app: App; variable?: EnvVar }) {
  const editing = variable !== undefined;
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(variable?.key ?? '');
  const [value, setValue] = useState(variable?.secret ? '' : (variable?.value ?? ''));
  const [secret, setSecret] = useState(variable?.secret ?? false);
  const save = useApiMutation(
    () =>
      putEnvVar(app.id, key, {
        // A secret keeps its stored value when the field is left empty.
        ...(editing && variable.secret && value === '' ? {} : { value }),
        secret,
      }),
    {
      invalidate: [keys.env],
      success: `${key} saved`,
      onSuccess: () => setOpen(false),
    },
  );
  const keyError = key === '' ? undefined : fieldError(EnvKey, key);
  // Turning a secret into a plain variable needs a new value (the old one is not readable).
  const needsValue = editing && variable.secret && !secret && value === '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !editing) {
          setKey('');
          setValue('');
          setSecret(false);
        }
      }}
    >
      <DialogTrigger asChild>
        {editing ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${variable.key}`}>
            <Pencil />
          </Button>
        ) : (
          <Button>
            <Plus /> Add variable
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${variable.key}` : 'Add variable'}</DialogTitle>
          <DialogDescription>Takes effect with the next deployment.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Key" error={keyError}>
            <Input
              className="font-mono"
              value={key}
              readOnly={editing}
              autoComplete="off"
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <Field
            label="Value"
            description={
              editing && variable.secret
                ? 'Leave empty to keep the current secret value.'
                : undefined
            }
          >
            <Textarea
              className="font-mono"
              rows={3}
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="env-secret" className="flex items-center gap-1.5">
                <EyeOff className="size-3.5" /> Secret
              </Label>
              <p className="text-xs text-muted-foreground">
                Hidden after saving, also from admins.
              </p>
            </div>
            <Switch id="env-secret" checked={secret} onCheckedChange={setSecret} />
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={key === '' || keyError !== undefined || needsValue || save.isPending}
            >
              {save.isPending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BulkPasteDialog({ app, existing }: { app: App; existing: readonly EnvVar[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [markSecret, setMarkSecret] = useState(false);
  const parsed = parseDotenv(text);
  const save = useApiMutation(
    () => setEnvVars(app.id, { variables: mergeEnvForBulk(existing, parsed.entries, markSecret) }),
    {
      invalidate: [keys.env],
      success: `${parsed.entries.length} variables saved`,
      onSuccess: () => {
        setOpen(false);
        setText('');
      },
    },
  );
  const overwritten = parsed.entries.filter((entry) =>
    existing.some((variable) => variable.key === entry.key),
  ).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <ClipboardPaste /> Paste .env
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste a .env file</DialogTitle>
          <DialogDescription>
            KEY=value lines; quotes, comments and <code>export</code> are understood. Existing keys
            are overwritten, others are kept.
          </DialogDescription>
        </DialogHeader>
        <Field label=".env contents">
          <Textarea
            className="min-h-48 font-mono text-xs"
            value={text}
            spellCheck={false}
            autoComplete="off"
            placeholder={'DATABASE_URL=postgres://…\nSESSION_SECRET="…"'}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        {parsed.errors.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-disc pl-4">
                {parsed.errors.slice(0, 5).map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Switch id="bulk-secret" checked={markSecret} onCheckedChange={setMarkSecret} />
            <Label htmlFor="bulk-secret">Mark all as secret</Label>
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {parsed.entries.length} variables
            {overwritten > 0 ? `, ${overwritten} overwrite existing keys` : ''}
          </p>
        </div>
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={parsed.entries.length === 0 || parsed.errors.length > 0 || save.isPending}
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Save variables
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
