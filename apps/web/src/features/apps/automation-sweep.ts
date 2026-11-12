import type { AutomationChange } from '@launchway/contracts';

/**
 * What to tell the person when a pause or a change of mode was saved (HTTP 207) but the sweep
 * could not confirm that every auto-merge the App enabled is off; null when all are.
 */
export function sweepWarning(change: Pick<AutomationChange, 'sweep'>): string | null {
  const failed = change.sweep?.failed ?? [];
  if (failed.length === 0) return null;
  return `Auto-merge may still be on for ${failed.map((number) => `#${number}`).join(', ')}; Launchway keeps trying`;
}
