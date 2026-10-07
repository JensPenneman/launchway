import { Email, Password, PublicUrl, SetupInput, z } from '@slipway/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { CheckCircle2, FolderGit2, Loader2, Server } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { createOwner, login, meQuery, setupStatusQuery } from '@/api/auth';
import { keys } from '@/api/keys';
import { updateSettings } from '@/api/platform';
import { errorMessage, isApiError } from '@/api/request';
import { AuthLayout } from '@/components/auth-layout';
import { Field } from '@/components/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { zodResolver } from '@/lib/form';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery).catch(() => null);
    if (status && !status.setupRequired) throw redirect({ to: '/' });
  },
  component: Setup,
});

const STEPS = ['Owner account', 'Platform', 'Done'] as const;

const OwnerForm = SetupInput.extend({ confirmPassword: z.string() }).refine(
  (v) => v.password === v.confirmPassword,
  { message: 'The passwords do not match', path: ['confirmPassword'] },
);

const PlatformForm = z.object({
  publicUrl: z.union([z.literal(''), PublicUrl]),
  acmeEmail: z.union([z.literal(''), Email]),
});

function Steps({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs" aria-label="Setup progress">
      {STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? 'step' : undefined}
          className="flex flex-1 flex-col gap-1.5"
        >
          <span
            className={cn('h-1 rounded-full', index <= current ? 'bg-primary' : 'bg-muted')}
            aria-hidden="true"
          />
          <span className={index === current ? 'font-medium' : 'text-muted-foreground'}>
            {index + 1}. {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Setup() {
  const [step, setStep] = useState(0);
  const [ownerEmail, setOwnerEmail] = useState('');
  return (
    <AuthLayout
      title="Set up Slipway"
      description="Create the owner account and tell Slipway where it lives."
      wide
    >
      <Steps current={step} />
      {step === 0 && (
        <OwnerStep
          onDone={(email) => {
            setOwnerEmail(email);
            setStep(1);
          }}
        />
      )}
      {step === 1 && <PlatformStep ownerEmail={ownerEmail} onDone={() => setStep(2)} />}
      {step === 2 && <DoneStep />}
    </AuthLayout>
  );
}

/** The installer prints the setup link as `/setup#token=<token>`; the fragment never reaches logs. */
function tokenFromFragment(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

function OwnerStep({ onDone }: { onDone: (email: string) => void }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery(setupStatusQuery);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(OwnerForm),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      setupToken: tokenFromFragment(),
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async ({ name, email, password, setupToken }) => {
    setError(null);
    try {
      await createOwner({ name, email, password, ...(setupToken ? { setupToken } : {}) });
      queryClient.setQueryData(keys.setup, { setupRequired: false, setupTokenRequired: false });
      // Setup normally signs the owner in; sign in explicitly if it did not.
      try {
        await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      } catch (cause) {
        if (!isApiError(cause, 'unauthorized')) throw cause;
        await login({ email, password });
        await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      }
      onDone(email);
    } catch (cause) {
      const fields = isApiError(cause) ? cause.fieldErrors() : {};
      for (const [field, message] of Object.entries(fields)) {
        if (
          field === 'name' ||
          field === 'email' ||
          field === 'password' ||
          field === 'setupToken'
        ) {
          form.setError(field, { message });
        }
      }
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
      {status?.setupTokenRequired && (
        <Field
          label="Setup token"
          error={errors.setupToken?.message}
          description="Printed by the installer; also SLIPWAY_SETUP_TOKEN in the installation's .env."
        >
          <Input autoComplete="off" spellCheck={false} {...form.register('setupToken')} />
        </Field>
      )}
      <Field label="Name" error={errors.name?.message}>
        <Input autoComplete="name" {...form.register('name')} />
      </Field>
      <Field label="E-mail" error={errors.email?.message}>
        <Input type="email" autoComplete="email" {...form.register('email')} />
      </Field>
      <Field
        label="Password"
        error={errors.password?.message}
        description={Password.description ?? 'At least 12 characters'}
      >
        <Input type="password" autoComplete="new-password" {...form.register('password')} />
      </Field>
      <Field label="Confirm password" error={errors.confirmPassword?.message}>
        <Input type="password" autoComplete="new-password" {...form.register('confirmPassword')} />
      </Field>
      <p className="text-xs text-muted-foreground">
        You can add a passkey from your account page once Slipway is set up.
      </p>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        Create owner account
      </Button>
    </form>
  );
}

function PlatformStep({ ownerEmail, onDone }: { ownerEmail: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(PlatformForm),
    defaultValues: { publicUrl: window.location.origin, acmeEmail: ownerEmail },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async ({ publicUrl, acmeEmail }) => {
    setError(null);
    try {
      await updateSettings({ publicUrl: publicUrl || null, acmeEmail: acmeEmail || null });
      onDone();
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
      <Field
        label="Platform URL"
        error={errors.publicUrl?.message}
        description="Origin of this Slipway installation, e.g. https://deploy.example.com. Slipway requests its certificate once DNS points here."
      >
        <Input type="url" inputMode="url" {...form.register('publicUrl')} />
      </Field>
      <Field
        label="Let's Encrypt e-mail"
        error={errors.acmeEmail?.message}
        description="Used for the ACME account; Let's Encrypt sends expiry notices here."
      >
        <Input type="email" {...form.register('acmeEmail')} />
      </Field>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Skip for now
        </Button>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
          Save and continue
        </Button>
      </div>
    </form>
  );
}

function DoneStep() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <CheckCircle2 className="size-8 text-emerald-500" aria-hidden="true" />
        <div>
          <p className="font-medium">Slipway is ready.</p>
          <p className="text-sm text-muted-foreground">
            Next: connect GitHub and check that the local node is online.
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant="outline" asChild>
          <Link to="/settings" search={{ tab: 'github' }}>
            <FolderGit2 /> Connect GitHub
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/nodes">
            <Server /> View nodes
          </Link>
        </Button>
      </div>
      <Button asChild>
        <Link to="/">Go to the overview</Link>
      </Button>
    </div>
  );
}
