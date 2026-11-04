import { NodeCheckConcurrency } from '@launchway/contracts';
import { fieldError } from '@/lib/form';

/**
 * The "Checks at once" text of a node: empty means the platform setting (null), else a whole
 * number the contract accepts.
 */
export function parseNodeCheckConcurrency(text: string): {
  value: number | null;
  error: string | undefined;
} {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null, error: undefined };
  const value = Number(trimmed);
  return { value, error: fieldError(NodeCheckConcurrency, value) };
}
