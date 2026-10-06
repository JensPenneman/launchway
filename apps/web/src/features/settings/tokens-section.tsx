import {
  type CreatedApiToken,
  DisplayName,
  TOKEN_SCOPES,
  type TokenScope,
} from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { KeySquare, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { createToken, revokeToken, tokensQuery } from '@/api/users';
import { ConfirmButton } from '@/components/confirm-button';
import { CopyBlock } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { StatusBadge } from '@/components/status-badge';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fieldError } from '@/lib/form';
import { formatDateTime, formatRelative } from '@/lib/format';

const SCOPE_HINTS: Record<TokenScope, string> = {
  read: 'Read everything a viewer can see',
  write: 'Deploy and manage apps, domains and DNS',
  admin: 'Everything your role allows, including settings and users',
};

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
] as const;

export function TokensSection() {
  const tokens = useQuery(tokensQuery);
  const revoke = useApiMutation(revokeToken, {
    invalidate: [keys.tokens],
    success: 'Token revoked',
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-sm text-muted-foreground">
          Use tokens for scripts and CI:{' '}
          <code className="font-mono">Authorization: Bearer slp_…</code>
        </p>
        <CreateTokenDialog />
      </div>
      {tokens.isPending ? (
        <ListSkeleton rows={3} />
      ) : tokens.isError ? (
        <ErrorAlert error={tokens.error} />
      ) : tokens.data.items.length === 0 ? (
        <EmptyState
          icon={KeySquare}
          title="No API tokens"
          description="Create one to call the API from scripts."
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead className="hidden md:table-cell">Expires</TableHead>
                <TableHead className="hidden sm:table-cell">Last used</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data.items.map((token) => {
                const expired =
                  token.expiresAt !== null && Date.parse(token.expiresAt) < Date.now();
                return (
                  <TableRow key={token.id}>
                    <TableCell>
                      <div className="font-medium">{token.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {token.tokenHint}…
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {token.scopes.map((scope) => (
                          <StatusBadge key={scope} tone="neutral">
                            {scope}
                          </StatusBadge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {expired ? (
                        <StatusBadge tone="danger">expired</StatusBadge>
                      ) : token.expiresAt ? (
                        formatDateTime(token.expiresAt)
                      ) : (
                        'never'
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {formatRelative(token.lastUsedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ConfirmButton
                        title={`Revoke ${token.name}?`}
                        description="Scripts using this token stop working immediately."
                        confirmLabel="Revoke token"
                        onConfirm={() => revoke.mutate(token.id)}
                      >
                        <Button variant="ghost" size="icon-sm" aria-label={`Revoke ${token.name}`}>
                          <Trash2 />
                        </Button>
                      </ConfirmButton>
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

function CreateTokenDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['read']);
  const [expiry, setExpiry] = useState<string>('90');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const create = useApiMutation(
    () =>
      createToken({
        name: name.trim(),
        scopes,
        expiresAt:
          expiry === 'never'
            ? null
            : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString(),
      }),
    { invalidate: [keys.tokens], success: 'Token created', onSuccess: setCreated },
  );
  const nameError = name === '' ? undefined : fieldError(DisplayName, name);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCreated(null);
          setName('');
          setScopes(['read']);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Create token
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? 'Copy your token' : 'Create an API token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'This is the only time the token is shown.'
              : 'Tokens act as you, limited by their scopes.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <Alert>
              <AlertDescription>
                Store it in your password manager or CI secrets now.
              </AlertDescription>
            </Alert>
            <CopyBlock label="Token" value={created.secret} />
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Name" error={nameError}>
              <Input
                placeholder="GitHub Actions"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Scopes</legend>
              {TOKEN_SCOPES.map((scope) => (
                <div key={scope} className="flex items-start gap-2">
                  <Checkbox
                    id={`scope-${scope}`}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(checked) =>
                      setScopes((current) =>
                        checked === true
                          ? [...current, scope]
                          : current.filter((value) => value !== scope),
                      )
                    }
                  />
                  <div className="grid gap-0.5">
                    <Label htmlFor={`scope-${scope}`}>{scope}</Label>
                    <p className="text-xs text-muted-foreground">{SCOPE_HINTS[scope]}</p>
                  </div>
                </div>
              ))}
            </fieldset>
            <Field label="Expires">
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  name.trim() === '' ||
                  nameError !== undefined ||
                  scopes.length === 0 ||
                  create.isPending
                }
              >
                {create.isPending && <Loader2 className="animate-spin" />}
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
