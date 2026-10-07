import { Hostname, PreviewLimit, type Settings } from '@launchway/contracts';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { updateSettings } from '@/api/platform';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { fieldError } from '@/lib/form';

/** Platform settings of pull request previews: the base domain and the limits. */
export function PreviewSettingsCard({ settings }: { settings: Settings }) {
  const [baseDomain, setBaseDomain] = useState(settings.previewBaseDomain ?? '');
  const [perApp, setPerApp] = useState(String(settings.previewMaxPerApp));
  const [total, setTotal] = useState(String(settings.previewMaxTotal));
  const baseError = baseDomain.trim() === '' ? undefined : fieldError(Hostname, baseDomain);
  const perAppError = fieldError(PreviewLimit, Number(perApp));
  const totalError = fieldError(PreviewLimit, Number(total));
  const valid = !baseError && !perAppError && !totalError && perApp !== '' && total !== '';

  const save = useApiMutation(
    () =>
      updateSettings({
        previewBaseDomain: baseDomain.trim() === '' ? null : baseDomain.trim().toLowerCase(),
        previewMaxPerApp: Number(perApp),
        previewMaxTotal: Number(total),
      }),
    { invalidate: [keys.settings], success: 'Preview settings saved' },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Previews</CardTitle>
        <CardDescription>
          Pull request previews get host names below the base domain, each with a CNAME to the
          anchor host name and its own Let's Encrypt certificate. The base domain must lie in a DNS
          zone of a connected provider account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Field
            label="Preview base domain"
            error={baseError}
            description="For example preview.example.com; empty turns previews off."
          >
            <Input
              className="font-mono"
              placeholder="preview.example.com"
              value={baseDomain}
              onChange={(event) => setBaseDomain(event.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Open previews per app" error={perAppError}>
              <Input
                inputMode="numeric"
                value={perApp}
                onChange={(event) => setPerApp(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
            <Field label="Open previews in total" error={totalError}>
              <Input
                inputMode="numeric"
                value={total}
                onChange={(event) => setTotal(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
          </div>
          <Button type="submit" className="self-start" disabled={!valid || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save preview settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
