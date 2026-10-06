import { createFileRoute } from '@tanstack/react-router';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/setup')({
  component: () => (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>Set up Slipway</h1>
          </CardTitle>
          <CardDescription>Create the owner account. Not available yet.</CardDescription>
        </CardHeader>
      </Card>
    </main>
  ),
});
