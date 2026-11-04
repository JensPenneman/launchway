import type { Node } from '@launchway/contracts';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { updateNode } from '@/api/nodes';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { parseNodeCheckConcurrency } from './check-concurrency';

/** "Checks at once" of a node: its own limit, or the platform setting when empty. */
export function CheckConcurrencyCard({ node, editable }: { node: Node; editable: boolean }) {
  const saved = node.checkConcurrency === null ? '' : String(node.checkConcurrency);
  const [text, setText] = useState(saved);
  const { value, error } = parseNodeCheckConcurrency(text);
  const save = useApiMutation(() => updateNode(node.id, { checkConcurrency: value }), {
    invalidate: [keys.nodes],
    success: 'Checks at once saved',
  });

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Checks at once</CardTitle>
        <CardDescription>
          How many checks this node runs side by side, all apps together. Every service of a check
          gets the platform limits, so the node needs that many times their memory and CPUs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {editable ? (
          <form
            className="flex flex-col gap-4"
            aria-label="Checks at once"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Field
              label="Checks at once"
              error={error}
              description="1 to 16. Leave empty to use the platform setting under Settings → Platform → Checks."
            >
              <Input
                inputMode="numeric"
                placeholder="Platform setting"
                value={text}
                onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
            <Button
              type="submit"
              className="self-start"
              disabled={error !== undefined || text === saved || save.isPending}
            >
              {save.isPending && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            {node.checkConcurrency === null
              ? 'The platform setting.'
              : `${node.checkConcurrency} at once.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
