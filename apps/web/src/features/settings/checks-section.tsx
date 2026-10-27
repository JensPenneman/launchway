import {
  CheckCpus,
  CheckMemoryMb,
  CheckPidsLimit,
  CheckQueueLimit,
  type Settings,
} from '@launchway/contracts';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { updateSettings } from '@/api/platform';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { memoryHint } from '@/features/settings/check-limits';
import { fieldError } from '@/lib/form';

const number = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));
const required = (text: string, error: string | undefined) =>
  text.trim() === '' ? 'Required' : error;

/** Platform limits of checks: memory, CPUs and processes of every service of a check run. */
export function CheckLimitsCard({ settings }: { settings: Settings }) {
  const [memory, setMemory] = useState(String(settings.checkMemoryMb));
  const [cpus, setCpus] = useState(String(settings.checkCpus));
  const [pids, setPids] = useState(String(settings.checkPidsLimit));
  const [perApp, setPerApp] = useState(String(settings.checkMaxQueuedPerApp));
  const [perNode, setPerNode] = useState(String(settings.checkMaxQueuedPerNode));
  const memoryError = required(memory, fieldError(CheckMemoryMb, number(memory)));
  const cpusError = required(cpus, fieldError(CheckCpus, number(cpus)));
  const pidsError = required(pids, fieldError(CheckPidsLimit, number(pids)));
  const perAppError = required(perApp, fieldError(CheckQueueLimit, number(perApp)));
  const perNodeError = required(perNode, fieldError(CheckQueueLimit, number(perNode)));
  const valid = !memoryError && !cpusError && !pidsError && !perAppError && !perNodeError;

  const save = useApiMutation(
    () =>
      updateSettings({
        checkMemoryMb: Number(memory),
        checkCpus: Number(cpus),
        checkPidsLimit: Number(pids),
        checkMaxQueuedPerApp: Number(perApp),
        checkMaxQueuedPerNode: Number(perNode),
      }),
    { invalidate: [keys.settings], success: 'Check limits saved' },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Checks</CardTitle>
        <CardDescription>
          Every service of a check gets these limits, so a check can use the number of its services
          times them in total; swap is off. Its image builds run in a builder with the same memory
          and CPUs. Runs beyond the queue limits end at once with an error on GitHub.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Memory (MiB)"
              error={memoryError}
              description={memoryHint(number(memory))}
            >
              <Input
                inputMode="numeric"
                value={memory}
                onChange={(event) => setMemory(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
            <Field label="CPUs" error={cpusError} description="In steps of 0.25">
              <Input
                type="number"
                min={0.25}
                max={128}
                step={0.25}
                value={cpus}
                onChange={(event) => setCpus(event.target.value)}
              />
            </Field>
            <Field label="Processes" error={pidsError} description="Processes and threads">
              <Input
                inputMode="numeric"
                value={pids}
                onChange={(event) => setPids(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Queued per app"
              error={perAppError}
              description="Checks an app may have waiting"
            >
              <Input
                inputMode="numeric"
                value={perApp}
                onChange={(event) => setPerApp(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
            <Field
              label="Queued per node"
              error={perNodeError}
              description="Checks of all apps waiting for one node"
            >
              <Input
                inputMode="numeric"
                value={perNode}
                onChange={(event) => setPerNode(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
          </div>
          <Button type="submit" className="self-start" disabled={!valid || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save check limits
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
