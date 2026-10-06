import type { ReactNode } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface PlaceholderPageProps {
  title: string;
  description: string;
  /** Planned sections, rendered as empty cards until the feature lands. */
  sections?: readonly string[];
  children?: ReactNode;
}

export function PlaceholderPage({
  title,
  description,
  sections = [],
  children,
}: PlaceholderPageProps) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
      {sections.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {sections.map((section) => (
            <Card key={section}>
              <CardHeader>
                <CardTitle>{section}</CardTitle>
                <CardDescription>Not available yet.</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
