import {
  type App,
  AUTOMATION_MODES,
  type AutomationChange,
  type AutomationMode,
} from '@launchway/contracts';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { automationRunsQuery, pauseAutomation, updateAutomation } from '@/api/automation';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatRelative } from '@/lib/format';
import { sweepWarning } from './automation-sweep';

const MODE_HINT: Record<AutomationMode, string> = {
  off: 'Nothing happens.',
  shadow:
    'Decisions are recorded and notified quietly; nothing is enabled or merged. An auto-merge the App enabled earlier is switched off.',
  on: 'Eligible Dependabot pull requests merge when their checks pass.',
};

/** Auto-merge of Dependabot pull requests: mode, pause and the last runs (ADR 0023). */
export function AutomationCard({ app }: { app: App }) {
  const runs = useQuery(automationRunsQuery(app.id));
  const settings = app.automation;
  const invalidate = [keys.apps];
  // A 207 saves the change but may leave an auto-merge on: say so, in a toast and on the card.
  const [warning, setWarning] = useState<string | null>(null);
  const warn = (change: AutomationChange) => {
    const text = sweepWarning(change);
    setWarning(text);
    if (text) toast.warning(text);
  };
  const setMode = useApiMutation((merge: AutomationMode) => updateAutomation(app.id, { merge }), {
    invalidate,
    success: 'Automation saved',
    onSuccess: warn,
  });
  const toggle = useApiMutation(
    () => (settings.paused ? updateAutomation(app.id, { paused: false }) : pauseAutomation(app.id)),
    {
      invalidate,
      success: settings.paused ? 'Automation resumed' : 'Automation paused',
      onSuccess: warn,
    },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
        <CardDescription>
          Merges the Dependabot pull requests that only change dependencies, are verified and come
          from Dependabot itself, once their checks are green. Changing the mode or resuming needs a
          session signed in with a passkey; pausing does not. Pausing or leaving On waits until
          every auto-merge the App enabled is off. While the automation is not Off, changing the
          checks or the GitHub connection needs a passkey session too.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {warning ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {warning}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-3">
          <div>
            <Label htmlFor="automation-merge-mode">Auto-merge</Label>
            <p className="text-xs text-muted-foreground">{MODE_HINT[settings.merge]}</p>
          </div>
          <Select
            value={settings.merge}
            onValueChange={(value) => setMode.mutate(value as AutomationMode)}
            disabled={setMode.isPending}
          >
            <SelectTrigger id="automation-merge-mode" size="sm" className="w-32 capitalize">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTOMATION_MODES.map((mode) => (
                <SelectItem key={mode} value={mode} className="capitalize">
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-3">
          <div>
            <Label>Pause</Label>
            <p className="text-xs text-muted-foreground">
              {settings.paused
                ? 'Paused: nothing is enabled and what the App enabled is switched off.'
                : 'Switches off every auto-merge the App enabled before it answers, and enables none.'}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {settings.paused ? <Play /> : <Pause />}
            {settings.paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Last runs</h3>
          {runs.data?.items.length ? (
            <ul className="flex flex-col divide-y rounded-lg border text-sm">
              {runs.data.items.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                  <span className="font-mono">{run.key}</span>
                  <Badge variant="outline">{run.state}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {typeof run.snapshot.reason === 'string' ? `${run.snapshot.reason} · ` : ''}
                    {formatRelative(run.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No pull request handled yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
