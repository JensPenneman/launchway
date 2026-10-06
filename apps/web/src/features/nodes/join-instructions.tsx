import type { NodeJoinToken } from '@slipway/contracts';
import { CopyBlock } from '@/components/copy-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelative } from '@/lib/format';

/** One-time join token with ready-made `docker run` and Compose snippets. */
export function JoinInstructions({ join }: { join: NodeJoinToken }) {
  return (
    <div className="flex flex-col gap-4" data-testid="join-instructions">
      <p className="text-sm text-muted-foreground">
        Run the agent on the new machine. The token works once and expires{' '}
        {formatRelative(join.expiresAt)}; it is not shown again.
      </p>
      <Tabs defaultValue="run">
        <TabsList>
          <TabsTrigger value="run">docker run</TabsTrigger>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="token">Token</TabsTrigger>
        </TabsList>
        <TabsContent value="run" className="mt-3">
          <CopyBlock label="Command" value={join.dockerRunCommand} />
        </TabsContent>
        <TabsContent value="compose" className="mt-3">
          <CopyBlock label="compose.yaml" value={join.composeSnippet} />
        </TabsContent>
        <TabsContent value="token" className="mt-3 flex flex-col gap-3">
          <CopyBlock label="SLIPWAY_JOIN_TOKEN" value={join.token} />
          <CopyBlock label="SLIPWAY_SERVER_URL" value={join.serverUrl} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
