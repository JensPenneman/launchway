import { createFileRoute } from '@tanstack/react-router';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/sign-in')({
  component: () => (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>Sign in</h1>
          </CardTitle>
          <CardDescription>
            Passkey first, password as a fallback. Not available yet.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  ),
});
