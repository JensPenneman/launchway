import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Centered card used by setup, sign-in and invitation pages (no app shell). */
export function AuthLayout({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-4 sm:p-6">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <img src="/favicon.svg" alt="" className="size-7" />
        Launchway
      </div>
      <Card className={wide ? 'w-full max-w-xl' : 'w-full max-w-md'}>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">{title}</h1>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
