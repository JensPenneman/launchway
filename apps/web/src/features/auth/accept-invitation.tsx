import { DisplayName, Email, Password, z } from '@launchway/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { login, meQuery } from '@/api/auth';
import { keys } from '@/api/keys';
import { errorMessage, isApiError } from '@/api/request';
import { acceptInvitation, invitationPreviewQuery } from '@/api/users';
import { AuthLayout } from '@/components/auth-layout';
import { Field } from '@/components/field';
import { ListSkeleton } from '@/components/query-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { zodResolver } from '@/lib/form';
import { formatRelative } from '@/lib/format';
import { isPasskeyCancelled, registerPasskey } from '@/lib/passkeys';

const AcceptForm = z
  .object({
    name: DisplayName,
    email: z.union([z.literal(''), Email]),
    password: z.union([z.literal(''), Password]),
  })
  .strict();

/** Invitation acceptance: preview, account details, then a passkey when no password was set. */
export function AcceptInvitation({ token }: { token: string }) {
  const preview = useQuery(invitationPreviewQuery(token));
  const [accepted, setAccepted] = useState<'password' | 'passkey' | null>(null);

  if (preview.isPending) {
    return (
      <AuthLayout title="Join Launchway">
        <ListSkeleton rows={3} />
      </AuthLayout>
    );
  }
  if (preview.isError) {
    const gone = isApiError(preview.error, 'not-found') || isApiError(preview.error, 'gone');
    return (
      <AuthLayout title="Invitation unavailable">
        <p className="text-sm text-muted-foreground">
          {gone
            ? 'This invitation link has expired or was already used. Ask an administrator for a new one.'
            : errorMessage(preview.error)}
        </p>
        <Button variant="link" className="mt-4 px-0" asChild>
          <Link to="/sign-in">Go to sign-in</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Join Launchway"
      description={
        <>
          You were invited as <strong className="text-foreground">{preview.data.role}</strong>. This
          link expires {formatRelative(preview.data.expiresAt)}.
        </>
      }
    >
      {accepted === 'passkey' ? (
        <PasskeyStep />
      ) : (
        <AcceptStep token={token} presetEmail={preview.data.email} onAccepted={setAccepted} />
      )}
    </AuthLayout>
  );
}

function AcceptStep({
  token,
  presetEmail,
  onAccepted,
}: {
  token: string;
  presetEmail: string | null;
  onAccepted: (method: 'password' | 'passkey') => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(AcceptForm),
    defaultValues: { name: '', email: presetEmail ?? '', password: '' },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async ({ name, email, password }) => {
    setError(null);
    if (!presetEmail && !email) {
      form.setError('email', { message: 'Enter your e-mail address' });
      return;
    }
    try {
      await acceptInvitation({
        token,
        name,
        ...(presetEmail ? {} : { email }),
        ...(password ? { password } : {}),
      });
      await queryClient.resetQueries({ queryKey: keys.me });
      if (password) {
        // Accepting may already sign the invitee in; otherwise sign in with the new password.
        await queryClient
          .fetchQuery(meQuery)
          .catch(() => login({ email: presetEmail ?? email, password }));
        await navigate({ to: '/' });
        return;
      }
      onAccepted('passkey');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4" noValidate>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field label="Name" error={errors.name?.message}>
        <Input autoComplete="name" {...form.register('name')} />
      </Field>
      <Field label="E-mail" error={errors.email?.message}>
        <Input
          type="email"
          autoComplete="email"
          readOnly={presetEmail !== null}
          {...form.register('email')}
        />
      </Field>
      <Field
        label="Password (optional)"
        error={errors.password?.message}
        description="Leave empty to sign in with a passkey only; you will create one next."
      >
        <Input type="password" autoComplete="new-password" {...form.register('password')} />
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        Accept invitation
      </Button>
    </form>
  );
}

function PasskeyStep() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      await navigate({ to: '/' });
    } catch (cause) {
      if (!isPasskeyCancelled(cause)) setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Your account exists. Create a passkey now; without a password it is how you sign in.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button onClick={() => void create()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Create a passkey
      </Button>
    </div>
  );
}
