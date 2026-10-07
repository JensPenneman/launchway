import { AllowedBindRoots } from '@launchway/contracts';
import { friendlyMessage } from '@/lib/form';

/** One root per line; blank lines and surrounding spaces are ignored. */
export function parseBindRoots(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The first problem of the list, naming the offending line. */
export function bindRootsError(roots: string[]): string | undefined {
  const issue = AllowedBindRoots.safeParse(roots, { error: friendlyMessage }).error?.issues[0];
  if (!issue) return undefined;
  const index = issue.path[0];
  return typeof index === 'number' ? `${roots[index]}: ${issue.message}` : issue.message;
}
