import type { Node } from '@launchway/contracts';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { updateNode } from '@/api/nodes';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { bindRootsError, parseBindRoots } from './bind-roots';

/** "Allowed bind-mount roots" of a node: read-only for members, editable for admins. */
export function BindRootsCard({ node, editable }: { node: Node; editable: boolean }) {
  const saved = node.allowedBindRoots.join('\n');
  const [text, setText] = useState(saved);
  const roots = parseBindRoots(text);
  const error = bindRootsError(roots);
  const save = useApiMutation(() => updateNode(node.id, { allowedBindRoots: roots }), {
    invalidate: [keys.nodes],
    success: 'Allowed bind-mount roots saved; they apply to the next deployment',
  });

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Allowed bind-mount roots</CardTitle>
        <CardDescription>
          Apps with trusted mounts on this node may bind-mount host directories below these paths.
          Untrusted apps never can.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editable ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Field
              label="Roots"
              error={error}
              description={
                <>
                  One absolute path per line, as the Docker daemon sees it. On Docker Desktop for
                  Windows a host drive is below{' '}
                  <code className="font-mono">/run/desktop/mnt/host/&lt;drive&gt;</code>, e.g.{' '}
                  <code className="font-mono">/run/desktop/mnt/host/d/Backups</code> for{' '}
                  <code className="font-mono">D:\Backups</code>.
                </>
              }
            >
              <Textarea
                rows={4}
                className="font-mono"
                placeholder="/srv/data"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              className="self-start"
              disabled={error !== undefined || text === saved || save.isPending}
            >
              {save.isPending && <Loader2 className="animate-spin" />}
              Save roots
            </Button>
          </form>
        ) : node.allowedBindRoots.length > 0 ? (
          <ul className="flex flex-col gap-1 font-mono text-sm">
            {node.allowedBindRoots.map((root) => (
              <li key={root}>{root}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None. Only an admin can add roots.</p>
        )}
      </CardContent>
    </Card>
  );
}
