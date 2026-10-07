import {
  type App,
  ComposeFiles,
  DEFAULT_PREVIEW_HOST_TEMPLATE,
  PREVIEW_ENV_PLACEHOLDERS,
  PreviewEnvOverrides,
  PreviewHostTemplate,
  PreviewLabel,
} from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { updateApp } from '@/api/apps';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { settingsQuery } from '@/api/platform';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { parseDotenv } from '@/lib/dotenv';
import { formatDotenv } from './previews-env';

/** Per-app preview settings; saved on their own, like the mounts card. */
export function PreviewsCard({ app }: { app: App }) {
  const platform = useQuery(settingsQuery);
  const [enabled, setEnabled] = useState(app.previews.enabled);
  const [skipBots, setSkipBots] = useState(app.previews.skipBots);
  const [requireLabel, setRequireLabel] = useState(app.previews.requireLabel ?? '');
  const [hostTemplate, setHostTemplate] = useState(app.previews.hostTemplate);
  const [overridesText, setOverridesText] = useState(formatDotenv(app.previews.envOverrides));
  const [composeFiles, setComposeFiles] = useState((app.previews.composeFiles ?? []).join('\n'));

  const parsedOverrides = parseDotenv(overridesText);
  const overrides = PreviewEnvOverrides.safeParse(
    Object.fromEntries(parsedOverrides.entries.map((entry) => [entry.key, entry.value])),
  );
  const overridesError =
    parsedOverrides.errors[0] ??
    (overrides.success ? undefined : overrides.error.issues[0]?.message);
  const template = PreviewHostTemplate.safeParse(hostTemplate);
  const composeList = composeFiles
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const compose = composeList.length === 0 ? null : ComposeFiles.safeParse(composeList);
  const composeError = compose && !compose.success ? compose.error.issues[0]?.message : undefined;
  const label = requireLabel.trim() === '' ? null : PreviewLabel.safeParse(requireLabel);
  const labelError = label && !label.success ? label.error.issues[0]?.message : undefined;
  const valid =
    template.success && overrides.success && !overridesError && !composeError && !labelError;

  const base = platform.data?.previewBaseDomain ?? null;
  const example = template.success
    ? template.data
        .replaceAll('{slug}', app.slug)
        .replaceAll('{number}', '42')
        .replaceAll('{base}', base ?? '<base domain>')
    : null;

  const save = useApiMutation(
    () =>
      updateApp(app.id, {
        previews: {
          enabled,
          skipBots,
          requireLabel: label?.success ? label.data : null,
          hostTemplate: template.success ? template.data : hostTemplate,
          envOverrides: overrides.success ? overrides.data : {},
          composeFiles: compose?.success ? compose.data : null,
        },
      }),
    { invalidate: [keys.apps, keys.previews], success: 'Preview settings saved' },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Previews</CardTitle>
        <CardDescription>
          Pull requests from branches of the repository run as their own copy of the app, with the
          service and options of the app's first route. Previews never get trusted mounts.
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
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="settings-previews-enabled">Deploy pull requests as previews</Label>
              <p className="text-xs text-muted-foreground">
                {base
                  ? `Host names go below ${base}.`
                  : 'Set the preview base domain in the platform settings first.'}
              </p>
            </div>
            <Switch id="settings-previews-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="settings-previews-skip-bots">Skip pull requests from bots</Label>
              <p className="text-xs text-muted-foreground">
                Pull requests by Dependabot and other bots get no preview; the Previews tab can
                still open one.
              </p>
            </div>
            <Switch
              id="settings-previews-skip-bots"
              checked={skipBots}
              onCheckedChange={setSkipBots}
            />
          </div>
          <Field
            label="Only pull requests with label"
            error={labelError}
            description="Optional. Adding the label opens the preview, removing it closes it. Leave empty to preview every pull request."
          >
            <Input
              placeholder="preview"
              value={requireLabel}
              onChange={(event) => setRequireLabel(event.target.value)}
            />
          </Field>
          <Field
            label="Host name template"
            error={template.success ? undefined : template.error.issues[0]?.message}
            description={
              <>
                Placeholders <code className="font-mono">{'{slug}'}</code>,{' '}
                <code className="font-mono">{'{number}'}</code> and{' '}
                <code className="font-mono">{'{base}'}</code>
                {example && (
                  <>
                    ; pull request 42 gets <code className="font-mono">{example}</code>
                  </>
                )}
                .
              </>
            }
          >
            <Input
              className="font-mono"
              placeholder={DEFAULT_PREVIEW_HOST_TEMPLATE}
              value={hostTemplate}
              onChange={(event) => setHostTemplate(event.target.value)}
            />
          </Field>
          <Field
            label="Environment overrides"
            error={overridesError}
            description={
              <>
                <code className="font-mono">KEY=value</code> per line, replacing or adding app
                variables in previews (secrets included otherwise). Placeholders:{' '}
                {PREVIEW_ENV_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}. Shown to every
                member: keep secrets in the app's environment.
              </>
            }
          >
            <Textarea
              rows={4}
              className="font-mono"
              placeholder={'BASE_URL={{previewUrl}}\nDATABASE_NAME=app_pr_{{prNumber}}'}
              value={overridesText}
              onChange={(event) => setOverridesText(event.target.value)}
            />
          </Field>
          <Field
            label="Compose files for previews"
            error={composeError}
            description="Optional, one path per line. Leave empty to build previews like the app, e.g. use a file without production volumes here."
          >
            <Textarea
              rows={2}
              className="font-mono"
              placeholder="compose.preview.yaml"
              value={composeFiles}
              onChange={(event) => setComposeFiles(event.target.value)}
            />
          </Field>
          <Button type="submit" className="self-start" disabled={!valid || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save preview settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
