import type { App } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { deleteApp, stopApp } from '@/api/apps';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { nodeQuery } from '@/api/nodes';
import { ConfirmButton } from '@/components/confirm-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export function DangerZoneTab({ app }: { app: App }) {
  const navigate = useNavigate();
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const node = useQuery(nodeQuery(app.nodeId));
  const nodeOffline = node.data !== undefined && node.data.status !== 'online';
  const stop = useApiMutation(() => stopApp(app.id), {
    invalidate: [keys.apps, keys.deployments],
    success: `${app.name} is stopping`,
  });
  const remove = useApiMutation(() => deleteApp(app.id, { removeVolumes, force: nodeOffline }), {
    invalidate: [keys.apps, keys.routes],
    success: `${app.name} deleted`,
    onSuccess: () => void navigate({ to: '/apps' }),
  });

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>These actions affect the running app immediately.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        <div className="flex flex-col justify-between gap-3 pb-4 sm:flex-row sm:items-center">
          <div>
            <p className="font-medium">Stop the app</p>
            <p className="text-sm text-muted-foreground">
              Runs <code>compose down</code>. Volumes, settings and domains stay; deploy again to
              start.
            </p>
          </div>
          <ConfirmButton
            title={`Stop ${app.name}?`}
            description="All containers of the app stop. Its domains answer with an error until the next deployment."
            confirmLabel="Stop app"
            onConfirm={() => stop.mutate()}
          >
            <Button variant="outline" disabled={app.activeDeploymentId === null || stop.isPending}>
              <Square /> Stop
            </Button>
          </ConfirmButton>
        </div>
        <div className="flex flex-col justify-between gap-3 pt-4 sm:flex-row sm:items-center">
          <div>
            <p className="font-medium">Delete the app</p>
            <p className="text-sm text-muted-foreground">
              Removes containers, deployments, environment variables and routes.
            </p>
          </div>
          <ConfirmButton
            title={`Delete ${app.name}?`}
            description="This cannot be undone."
            confirmLabel="Delete app"
            confirmText={app.slug}
            onConfirm={() => remove.mutate()}
            extra={
              <div className="flex flex-col gap-2">
                <div className="flex items-start gap-2 rounded-lg border p-3">
                  <Checkbox
                    id="delete-data"
                    checked={removeVolumes}
                    onCheckedChange={(checked) => setRemoveVolumes(checked === true)}
                  />
                  <div className="grid gap-1">
                    <Label htmlFor="delete-data">Also delete data volumes</Label>
                    <p className="text-xs text-muted-foreground">
                      Runs <code>compose down --volumes</code>. Databases and uploads are lost.
                    </p>
                  </div>
                </div>
                {nodeOffline && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {node.data?.name} is offline: Slipway forgets the app, but its containers stay
                    on the node until you remove them there.
                  </p>
                )}
              </div>
            }
          >
            <Button variant="destructive" disabled={remove.isPending}>
              <Trash2 /> Delete
            </Button>
          </ConfirmButton>
        </div>
      </CardContent>
    </Card>
  );
}
