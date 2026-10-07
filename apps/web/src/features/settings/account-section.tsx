import { DisplayName, Email, type Passkey, Password, z } from '@launchway/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, LogOut, Monitor, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  changePassword,
  deletePasskey,
  passkeysQuery,
  renamePasskey,
  revokeSession,
  sessionsQuery,
  updateMe,
} from '@/api/auth';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { errorMessage } from '@/api/request';
import { ConfirmButton } from '@/components/confirm-button';
import { Field } from '@/components/field';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { StatusBadge } from '@/components/status-badge';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useMe } from '@/hooks/use-me';
import { zodResolver } from '@/lib/form';
import { formatRelative } from '@/lib/format';
import { isPasskeyCancelled, registerPasskey } from '@/lib/passkeys';
import { describeUserAgent } from '@/lib/user-agent';

export function AccountSection() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ProfileCard />
      <PasswordCard />
      <PasskeysCard />
      <SessionsCard />
    </div>
  );
}

const ProfileForm = z.object({ name: DisplayName, email: Email });

function ProfileCard() {
  const me = useMe();
  const form = useForm({
    resolver: zodResolver(ProfileForm),
    values: { name: me?.user.name ?? '', email: me?.user.email ?? '' },
  });
  const save = useApiMutation(updateMe, {
    invalidate: [keys.me, keys.users],
    success: 'Profile saved',
  });
  const errors = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Role: {me?.user.role}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void form.handleSubmit((values) => save.mutate(values))(event)}
          noValidate
        >
          <Field label="Name" error={errors.name?.message}>
            <Input autoComplete="name" {...form.register('name')} />
          </Field>
          <Field label="E-mail" error={errors.email?.message}>
            <Input type="email" autoComplete="email" {...form.register('email')} />
          </Field>
          <Button
            type="submit"
            className="self-start"
            disabled={save.isPending || !form.formState.isDirty}
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Save profile
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const PasswordForm = z
  .object({ currentPassword: z.string().max(256), newPassword: Password, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, {
    message: 'The passwords do not match',
    path: ['confirm'],
  });

function PasswordCard() {
  const me = useMe();
  const hasPassword = me?.user.hasPassword ?? false;
  const form = useForm({
    resolver: zodResolver(PasswordForm),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const save = useApiMutation(changePassword, {
    invalidate: [keys.me, keys.sessions],
    success: 'Password changed',
    onSuccess: () => form.reset(),
  });
  const errors = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          {hasPassword
            ? 'Change the password you sign in with.'
            : 'You sign in with passkeys only. Add a password as a fallback.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) =>
            void form.handleSubmit(({ currentPassword, newPassword }) =>
              save.mutate({ newPassword, ...(hasPassword ? { currentPassword } : {}) }),
            )(event)
          }
        >
          {hasPassword && (
            <Field label="Current password" error={errors.currentPassword?.message}>
              <Input
                type="password"
                autoComplete="current-password"
                {...form.register('currentPassword')}
              />
            </Field>
          )}
          <Field
            label="New password"
            error={errors.newPassword?.message}
            description="At least 12 characters."
          >
            <Input type="password" autoComplete="new-password" {...form.register('newPassword')} />
          </Field>
          <Field label="Confirm new password" error={errors.confirm?.message}>
            <Input type="password" autoComplete="new-password" {...form.register('confirm')} />
          </Field>
          <Button type="submit" className="self-start" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {hasPassword ? 'Change password' : 'Set password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasskeysCard() {
  const passkeys = useQuery(passkeysQuery);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const remove = useApiMutation(deletePasskey, {
    invalidate: [keys.passkeys, keys.me],
    success: 'Passkey removed',
  });
  const add = async () => {
    setBusy(true);
    try {
      await registerPasskey();
      toast.success('Passkey added');
      await queryClient.invalidateQueries({ queryKey: keys.me });
    } catch (cause) {
      if (!isPasskeyCancelled(cause)) toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in with Touch ID, Windows Hello, a phone or a security key.
        </CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => void add()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Add passkey
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {passkeys.isPending ? (
          <ListSkeleton rows={2} />
        ) : passkeys.isError ? (
          <ErrorAlert error={passkeys.error} />
        ) : passkeys.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passkeys yet.</p>
        ) : (
          <ul className="divide-y" aria-label="Passkeys">
            {passkeys.data.items.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{passkey.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {passkey.backedUp ? 'synced' : 'this device only'} · added{' '}
                    {formatRelative(passkey.createdAt)} · used {formatRelative(passkey.lastUsedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <RenamePasskeyDialog passkey={passkey} />
                  <ConfirmButton
                    title={`Remove ${passkey.name}?`}
                    description="You can no longer sign in with this passkey."
                    confirmLabel="Remove passkey"
                    onConfirm={() => remove.mutate(passkey.id)}
                  >
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${passkey.name}`}>
                      <Trash2 />
                    </Button>
                  </ConfirmButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RenamePasskeyDialog({ passkey }: { passkey: Passkey }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(passkey.name);
  const rename = useApiMutation(() => renamePasskey(passkey.id, { name: name.trim() }), {
    invalidate: [keys.passkeys],
    success: 'Passkey renamed',
    onSuccess: () => setOpen(false),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Rename ${passkey.name}`}>
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename passkey</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={name.trim() === '' || rename.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SessionsCard() {
  const sessions = useQuery(sessionsQuery);
  const revoke = useApiMutation(revokeSession, {
    invalidate: [keys.sessions],
    success: 'Session signed out',
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>Browsers signed in to your account.</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <ListSkeleton rows={2} />
        ) : sessions.isError ? (
          <ErrorAlert error={sessions.error} />
        ) : (
          <ul className="divide-y" aria-label="Sessions">
            {sessions.data.items.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="truncate text-sm" title={session.userAgent ?? ''}>
                      {describeUserAgent(session.userAgent)}
                      {session.current && (
                        <StatusBadge tone="success" className="ml-2">
                          this browser
                        </StatusBadge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {session.ipAddress ?? 'unknown address'} · active{' '}
                      {formatRelative(session.lastUsedAt)}
                    </p>
                  </div>
                </div>
                {!session.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke.mutate(session.id)}
                    aria-label="Sign out this session"
                  >
                    <LogOut /> Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
