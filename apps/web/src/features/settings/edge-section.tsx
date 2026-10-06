import { useQuery } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { edgeConfigQuery, reloadEdge } from '@/api/platform';
import { CopyButton } from '@/components/copy-button';
import { ErrorAlert, ListSkeleton } from '@/components/query-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatRelative } from '@/lib/format';

export function EdgeSection() {
  const config = useQuery(edgeConfigQuery);
  const reload = useApiMutation(reloadEdge, {
    invalidate: [keys.edge],
    success: 'Edge configuration reloaded',
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Edge configuration</CardTitle>
        <CardDescription>
          {config.data
            ? `Rendered ${formatRelative(config.data.renderedAt)} · loaded into Caddy ${formatRelative(config.data.loadedAt)}`
            : 'The Caddyfile Slipway renders from routes and settings (read-only).'}
        </CardDescription>
        <CardAction className="flex gap-2">
          {config.data && <CopyButton value={config.data.caddyfile} />}
          <Button size="sm" onClick={() => reload.mutate()} disabled={reload.isPending}>
            {reload.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Reload
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {config.data?.lastError && (
          <Alert variant="destructive">
            <AlertTitle>Caddy rejected the last configuration</AlertTitle>
            <AlertDescription>
              {config.data.lastError.message} ({formatRelative(config.data.lastError.at)})
            </AlertDescription>
          </Alert>
        )}
        {config.data?.inSync === false && !config.data.lastError && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            Caddy is not running this configuration yet; reload to apply it.
          </p>
        )}
        {config.isPending ? (
          <ListSkeleton rows={6} />
        ) : config.isError ? (
          <ErrorAlert error={config.error} onRetry={() => void config.refetch()} />
        ) : (
          <pre
            className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-relaxed"
            data-testid="caddyfile"
          >
            {config.data.caddyfile}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
