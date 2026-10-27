import {
  type App,
  checkStatusContext,
  MAX_CHECK_ITEMS,
  type UpdateAppChecksSettings,
} from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  Controller,
  type FieldErrors,
  type Resolver,
  set,
  useFieldArray,
  useForm,
} from 'react-hook-form';
import { updateApp } from '@/api/apps';
import { capabilitiesQuery } from '@/api/github';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { Field } from '@/components/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { statusesBlocked } from '@/features/settings/github-capabilities';
import { type ChecksForm, newCheckItem, parseChecksForm, toChecksForm } from './checks-form';

const resolver: Resolver<ChecksForm, unknown, UpdateAppChecksSettings> = async (values) => {
  const result = parseChecksForm(values);
  if (result.success) return { values: result.data, errors: {} };
  const errors: FieldErrors<ChecksForm> = {};
  for (const [path, message] of Object.entries(result.errors)) {
    set(errors, path, { type: 'validate', message });
  }
  return { values: {}, errors };
};

/** Per-app check settings and the list of checks; saved on their own, like the previews card. */
export function ChecksCard({ app }: { app: App }) {
  const form = useForm<ChecksForm, unknown, UpdateAppChecksSettings>({
    values: toChecksForm(app.checks),
    resolver,
    mode: 'onTouched',
  });
  const items = useFieldArray({ control: form.control, name: 'items' });
  const capabilities = useQuery(capabilitiesQuery(app.connectionId));
  const save = useApiMutation((checks: UpdateAppChecksSettings) => updateApp(app.id, { checks }), {
    invalidate: [keys.apps],
    success: 'Check settings saved',
  });
  const errors = form.formState.errors;
  const names = form.watch('items').map((item) => item.name.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle>Checks</CardTitle>
        <CardDescription>
          Checks run their commands in the app's own dev-container Compose project on its node, get
          no app variables or secrets, and appear on GitHub as{' '}
          <code className="font-mono">launchway/&lt;name&gt;</code> commit statuses that branch
          protection can require.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          aria-label="Check settings"
          noValidate
          onSubmit={(event) => void form.handleSubmit((values) => save.mutate(values))(event)}
        >
          {capabilities.data && statusesBlocked(capabilities.data) && (
            <Alert>
              <TriangleAlert />
              <AlertDescription>
                GitHub does not accept commit statuses from this app's connection yet, so check
                results do not show there. An admin can grant Commit statuses: Read and write under
                Settings → GitHub.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="settings-checks-enabled">
                Run checks for pushes and pull requests
              </Label>
              <p className="text-xs text-muted-foreground">
                Pushes and pull requests from branches of {app.repository.owner}/
                {app.repository.name} run every check (webhooks, limited to the branches below).
                Running them by hand works either way.
              </p>
            </div>
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Switch
                  id="settings-checks-enabled"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="settings-checks-skip-bots">
                Skip pushes and pull requests from bots
              </Label>
              <p className="text-xs text-muted-foreground">
                Dependabot and other bots run no checks; you can still run them by hand.
              </p>
            </div>
            <Controller
              control={form.control}
              name="skipBots"
              render={({ field }) => (
                <Switch
                  id="settings-checks-skip-bots"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
          </div>
          <Field
            label="Branches"
            error={errors.branches?.message}
            description="Exact branch names, separated by commas or spaces: pushes to these branches and pull requests into them run the checks. Leave empty for every branch."
          >
            <Input className="font-mono" placeholder="main" {...form.register('branches')} />
          </Field>
          <Field
            label="Compose files of the checks"
            error={errors.composeFiles?.message}
            description="One path per line, merged in order; the dev container by default."
          >
            <Textarea
              rows={2}
              className="font-mono"
              placeholder=".devcontainer/compose.yaml"
              {...form.register('composeFiles')}
            />
          </Field>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                Checks{' '}
                <span className="font-normal text-muted-foreground">
                  ({items.fields.length}/{MAX_CHECK_ITEMS})
                </span>
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={items.fields.length >= MAX_CHECK_ITEMS}
                onClick={() => items.append(newCheckItem())}
              >
                <Plus /> Add check
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A check runs its command with <code className="font-mono">sh -c</code> in a service (
              <code className="font-mono">dev</code> by default) and passes when it exits with 0.
              Its name (lowercase letters, digits and dashes) is also its GitHub status; the timeout
              (1 to 120 minutes, 30 by default) does not count building the images, and a Compose
              file of its own replaces the Compose files above.
            </p>
            {items.fields.length === 0 && (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                No checks yet. Add the commands that test this app, such as{' '}
                <code className="font-mono">npm ci &amp;&amp; npm test</code>.
              </p>
            )}
            {items.fields.map((field, index) => {
              const itemErrors = errors.items?.[index];
              const name = names[index] ?? '';
              return (
                <fieldset key={field.id} className="flex flex-col gap-3 rounded-lg border p-3">
                  <legend className="sr-only">Check {index + 1}</legend>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-mono text-sm font-medium">
                      {name ? checkStatusContext(name) : `Check ${index + 1}`}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove check ${name || index + 1}`}
                      onClick={() => items.remove(index)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name" error={itemErrors?.name?.message}>
                      <Input
                        className="font-mono"
                        placeholder="quality"
                        autoComplete="off"
                        {...form.register(`items.${index}.name`)}
                      />
                    </Field>
                    <Field label="Service" error={itemErrors?.service?.message}>
                      <Input
                        className="font-mono"
                        placeholder="dev"
                        {...form.register(`items.${index}.service`)}
                      />
                    </Field>
                  </div>
                  <Field label="Command" error={itemErrors?.command?.message}>
                    <Textarea
                      rows={2}
                      className="font-mono"
                      placeholder="npm ci && npm test"
                      {...form.register(`items.${index}.command`)}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Timeout (minutes)" error={itemErrors?.timeoutMinutes?.message}>
                      <Input
                        inputMode="numeric"
                        placeholder="30"
                        {...form.register(`items.${index}.timeoutMinutes`)}
                      />
                    </Field>
                    <Field label="Compose file (optional)" error={itemErrors?.composeFile?.message}>
                      <Input
                        className="font-mono"
                        placeholder=".devcontainer/compose.e2e.yaml"
                        {...form.register(`items.${index}.composeFile`)}
                      />
                    </Field>
                  </div>
                </fieldset>
              );
            })}
            {errors.items?.root?.message && (
              <p className="text-xs text-destructive" role="alert">
                {errors.items.root.message}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="self-start"
            disabled={save.isPending || !form.formState.isDirty}
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Save check settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
