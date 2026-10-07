import type { Deployment } from '@launchway/contracts';

const timeFormat = new Intl.DateTimeFormat('en', { timeStyle: 'short' });

/**
 * "Waiting for image, retry 2 at 14:05" while an automatic deployment waits for its image to be
 * published (ADR 0019); null otherwise.
 */
export function imageRetryLabel(
  deployment: Pick<Deployment, 'status' | 'retryCount' | 'nextAttemptAt' | 'failureReason'>,
  format: (date: Date) => string = (date) => timeFormat.format(date),
): string | null {
  if (
    deployment.status !== 'queued' ||
    deployment.failureReason !== 'image-not-found' ||
    deployment.retryCount === 0 ||
    !deployment.nextAttemptAt
  ) {
    return null;
  }
  return `Waiting for image, retry ${deployment.retryCount} at ${format(new Date(deployment.nextAttemptAt))}`;
}
