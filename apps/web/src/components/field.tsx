import { cloneElement, type ReactElement, type ReactNode, useId } from 'react';
import { Label } from '@/components/ui/label';

interface FieldProps {
  label: ReactNode;
  error?: string | undefined;
  description?: ReactNode;
  /** A single form control; it receives `id`, `aria-invalid` and `aria-describedby`. */
  children: ReactElement<Record<string, unknown>>;
  className?: string;
}

/** Label + control + description/error with the accessibility attributes wired up. */
export function Field({ label, error, description, children, className }: FieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [description ? descriptionId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className ?? 'flex flex-col gap-1.5'}>
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy || undefined,
      })}
      {description && !error && (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
