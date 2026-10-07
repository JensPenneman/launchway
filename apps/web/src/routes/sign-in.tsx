import { LoginInput } from '@launchway/contracts';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { login, meQuery } from '@/api/auth';
import { keys } from '@/api/keys';
import { errorMessage, isApiError } from '@/api/request';
import { AuthLayout } from '@/components/auth-layout';
import { Field } from '@/components/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { zodResolver } from '@/lib/form';
import { isPasskeyCancelled, signInWithPasskey } from '@/lib/passkeys';
import { safeRedirect } from '@/lib/redirect';

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirect(search.redirect);
    return redirect ? { redirect } : {};
  },
  // Already signed in (e.g. a stale bookmark): continue where the user wanted to go.
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.fetchQuery(meQuery).catch(() => null);
    if (me) throw redirect({ to: search.redirect ?? '/' });
  },
  component: SignIn,
});

function SignIn() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const form = useForm({
    resolver: zodResolver(LoginInput),
    defaultValues: { email: '', password: '' },
  });

  const finish = async () => {
    await queryClient.resetQueries({ queryKey: keys.me });
    await navigate({ to: redirect ?? '/' });
  };

  const onPasskey = async () => {
    setError(null);
    setPasskeyBusy(true);
    try {
      await signInWithPasskey();
      await finish();
    } catch (cause) {
      if (!isPasskeyCancelled(cause)) setError(errorMessage(cause));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await login(values);
      await finish();
    } catch (cause) {
      setError(
        isApiError(cause, 'unauthorized')
          ? 'The e-mail or password is incorrect.'
          : errorMessage(cause),
      );
    }
  });

  const supportsPasskeys = browserSupportsWebAuthn();

  return (
    <AuthLayout title="Sign in" description="Use your passkey, or your e-mail and password.">
      <div className="flex flex-col gap-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          size="lg"
          className="h-10"
          onClick={() => void onPasskey()}
          disabled={passkeyBusy || !supportsPasskeys}
        >
          {passkeyBusy ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Sign in with a passkey
        </Button>
        {!supportsPasskeys && (
          <p className="text-center text-xs text-muted-foreground">
            This browser does not support passkeys.
          </p>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Separator className="flex-1" />
          or with a password
          <Separator className="flex-1" />
        </div>
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="E-mail" error={form.formState.errors.email?.message}>
            <Input type="email" autoComplete="username webauthn" {...form.register('email')} />
          </Field>
          <Field label="Password" error={form.formState.errors.password?.message}>
            <Input type="password" autoComplete="current-password" {...form.register('password')} />
          </Field>
          <Button type="submit" variant="outline" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Sign in
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
