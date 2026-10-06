import {
  type AssignableRole,
  type CreatedInvitation,
  Email,
  roleAtLeast,
  USER_ROLES,
  type User,
} from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import {
  createInvitation,
  deleteUser,
  invitationsQuery,
  revokeInvitation,
  updateUser,
  usersQuery,
} from '@/api/users';
import { ConfirmButton } from '@/components/confirm-button';
import { CopyBlock } from '@/components/copy-button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useMe } from '@/hooks/use-me';
import { fieldError } from '@/lib/form';
import { formatRelative } from '@/lib/format';
import { effectiveRole } from '@/lib/roles';

const ASSIGNABLE: AssignableRole[] = USER_ROLES.filter(
  (role): role is AssignableRole => role !== 'owner',
);

const ROLE_HINTS: Record<AssignableRole, string> = {
  admin: 'Everything except managing the owner',
  member: 'Apps, deployments, domains',
  viewer: 'Read-only, no secrets',
};

/** Whether the signed-in user may change or remove `user`. */
function canManage(actorRole: User['role'], actorId: string, user: User): boolean {
  if (user.role === 'owner' || user.id === actorId) return false;
  return actorRole === 'owner' || (roleAtLeast(actorRole, 'admin') && user.role !== 'admin');
}

export function UsersSection() {
  const me = useMe();
  const users = useQuery(usersQuery);
  const update = useApiMutation(
    ({ id, role }: { id: string; role: AssignableRole }) => updateUser(id, { role }),
    { invalidate: [keys.users], success: 'Role changed' },
  );
  const remove = useApiMutation(deleteUser, { invalidate: [keys.users], success: 'User removed' });
  const actorRole = me ? effectiveRole(me) : 'viewer';

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>People who can sign in to this Slipway.</CardDescription>
        </CardHeader>
        <CardContent>
          {users.isPending ? (
            <ListSkeleton rows={3} />
          ) : users.isError ? (
            <ErrorAlert error={users.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">Sign-in</TableHead>
                  <TableHead className="hidden sm:table-cell">Last login</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.items.map((user) => {
                  const manageable = me ? canManage(actorRole, me.user.id, user) : false;
                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="font-medium">{user.name}</div>
                        <div className="text-xs text-muted-foreground">{user.email}</div>
                      </TableCell>
                      <TableCell>
                        {manageable && user.role !== 'owner' ? (
                          <Select
                            value={user.role}
                            onValueChange={(role) =>
                              update.mutate({ id: user.id, role: role as AssignableRole })
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              className="w-28"
                              aria-label={`Role of ${user.name}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE.filter(
                                (role) => actorRole === 'owner' || role !== 'admin',
                              ).map((role) => (
                                <SelectItem key={role} value={role}>
                                  {role}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge tone={user.role === 'owner' ? 'info' : 'neutral'}>
                            {user.role}
                          </StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                        {[
                          user.hasPassword ? 'password' : null,
                          user.passkeyCount > 0 ? `${user.passkeyCount} passkey(s)` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {formatRelative(user.lastLoginAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {manageable && (
                          <ConfirmButton
                            title={`Remove ${user.name}?`}
                            description="Their sessions, passkeys and API tokens stop working."
                            confirmLabel="Remove user"
                            onConfirm={() => remove.mutate(user.id)}
                          >
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${user.name}`}
                            >
                              <Trash2 />
                            </Button>
                          </ConfirmButton>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <InvitationsCard canInviteAdmins={actorRole === 'owner'} />
    </div>
  );
}

function InvitationsCard({ canInviteAdmins }: { canInviteAdmins: boolean }) {
  const invitations = useQuery(invitationsQuery);
  const revoke = useApiMutation(revokeInvitation, {
    invalidate: [keys.invitations],
    success: 'Invitation revoked',
  });
  const pending = (invitations.data?.items ?? []).filter(
    (invitation) => invitation.status === 'pending',
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
        <CardDescription>
          Single-use links; the invitee picks a name and a password or passkey.
        </CardDescription>
        <CardAction>
          <InviteDialog canInviteAdmins={canInviteAdmins} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {invitations.isPending ? (
          <ListSkeleton rows={2} />
        ) : invitations.isError ? (
          <ErrorAlert error={invitations.error} />
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open invitations.</p>
        ) : (
          <ul className="divide-y" aria-label="Open invitations">
            {pending.map((invitation) => (
              <li key={invitation.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {invitation.email ?? 'Anyone with the link'} ·{' '}
                    <StatusBadge tone="neutral">{invitation.role}</StatusBadge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    expires {formatRelative(invitation.expiresAt)}
                    {invitation.invitedBy && ` · by ${invitation.invitedBy.name}`}
                  </p>
                </div>
                <ConfirmButton
                  title="Revoke this invitation?"
                  description="The link stops working."
                  confirmLabel="Revoke"
                  onConfirm={() => revoke.mutate(invitation.id)}
                >
                  <Button variant="ghost" size="icon-sm" aria-label="Revoke invitation">
                    <Trash2 />
                  </Button>
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function InviteDialog({ canInviteAdmins }: { canInviteAdmins: boolean }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AssignableRole>('member');
  const [email, setEmail] = useState('');
  const [hours, setHours] = useState('72');
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const create = useApiMutation(
    () => createInvitation({ role, expiresInHours: Number(hours), ...(email ? { email } : {}) }),
    { invalidate: [keys.invitations], success: 'Invitation created', onSuccess: setCreated },
  );
  const emailError = email === '' ? undefined : fieldError(Email, email);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCreated(null);
          setEmail('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus /> Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? 'Share the invitation link' : 'Invite someone'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'The link is shown once. Send it over a channel you trust.'
              : 'Creates a single-use link.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <>
            <CopyBlock label="Invitation link" value={created.url} />
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
            <Field label="Role" description={ROLE_HINTS[role]}>
              <Select value={role} onValueChange={(value) => setRole(value as AssignableRole)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE.filter((value) => canInviteAdmins || value !== 'admin').map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="E-mail (optional)"
              error={emailError}
              description="Restricts the link to this address."
            >
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Valid for">
              <Select value={hours} onValueChange={setHours}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24">1 day</SelectItem>
                  <SelectItem value="72">3 days</SelectItem>
                  <SelectItem value="168">7 days</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={emailError !== undefined || create.isPending}>
                {create.isPending && <Loader2 className="animate-spin" />}
                Create link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
