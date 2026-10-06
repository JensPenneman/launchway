import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface RadioCardProps {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
}

/** Native radio button styled as a selectable card (arrow keys move within the group). */
export function RadioCard({ name, value, checked, onSelect, children, className }: RadioCardProps) {
  return (
    <label
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring',
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        // Covers the card, so clicks anywhere select it and screen readers see a native radio.
        className="absolute inset-0 z-10 cursor-pointer appearance-none rounded-lg opacity-0"
      />
      <div className="min-w-0 flex-1">{children}</div>
      {checked && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
    </label>
  );
}

/** Group of radio cards with an accessible name. */
export function RadioCardGroup({
  legend,
  children,
  className,
}: {
  legend: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn('flex flex-col gap-2', className)}>
      <legend className="sr-only">{legend}</legend>
      {children}
    </fieldset>
  );
}
