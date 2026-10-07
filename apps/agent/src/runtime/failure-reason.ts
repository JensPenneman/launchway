import type { DeploymentFailureReason } from '@launchway/contracts';

/** The deployment step a failed command belonged to. */
export type FailedStep = 'checkout' | 'config' | 'build' | 'pull' | 'up' | 'other';

/**
 * Registry answers meaning "this image or tag does not exist (yet)". Docker, Compose, BuildKit
 * and containerd word it differently:
 *
 * - `manifest for ghcr.io/acme/app:sha-1 not found: manifest unknown: manifest unknown`
 * - `Error response from daemon: manifest unknown` (Compose v2 per-service: `app Error manifest unknown`)
 * - `repository ghcr.io/acme/app not found: name unknown: repository name not known to registry`
 * - `failed to resolve reference "ghcr.io/acme/app:sha-1": ghcr.io/acme/app:sha-1: not found`
 * - BuildKit (`FROM` a missing base): `failed to resolve source metadata for ghcr.io/acme/base:1: ... not found`
 * - a bare `404 Not Found` from the registry API (pull only).
 *
 * `denied` / `unauthorized` / `pull access denied` are deliberately not matched: they also mean
 * missing credentials, and retrying would only hide that.
 */
const IMAGE_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /\bmanifest unknown\b/i,
  /\bname unknown\b/i,
  /\bmanifest for \S+ not found\b/i,
  /\bfailed to resolve reference "[^"]+":.*\bnot found\b/i,
  /\bfailed to resolve source metadata for \S+:.*\bnot found\b/i,
];

/**
 * A bare HTTP 404 only counts during `pull`: in `build`, a `RUN curl`/`wget` of a missing file
 * prints the same words and must stay a build failure.
 */
const REGISTRY_404_PATTERNS: readonly RegExp[] = [
  /\berror parsing HTTP 404 response body\b/i,
  /\bunexpected status(?: code)?:? 404\b/i,
  /\b404 (?:page )?not found\b/i,
];

const ACCESS_DENIED = /\b(?:denied|unauthorized|authentication required)\b/i;

/** True when output lines show the registry does not (yet) have the requested image. */
export function isImageNotFound(
  lines: readonly string[],
  options: { registry404?: boolean } = {},
): boolean {
  const patterns = options.registry404
    ? [...IMAGE_NOT_FOUND_PATTERNS, ...REGISTRY_404_PATTERNS]
    : IMAGE_NOT_FOUND_PATTERNS;
  return lines.some(
    (line) => !ACCESS_DENIED.test(line) && patterns.some((pattern) => pattern.test(line)),
  );
}

/**
 * Classifies a failed deployment command (ADR 0019). Image fetches happen in `build --pull`
 * (base images) and `pull`; only there does an unknown image become `image-not-found`.
 */
export function classifyFailure(
  step: FailedStep,
  output: readonly string[],
): DeploymentFailureReason {
  switch (step) {
    case 'build':
      return isImageNotFound(output) ? 'image-not-found' : 'build';
    case 'pull':
      return isImageNotFound(output, { registry404: true }) ? 'image-not-found' : 'build';
    case 'checkout':
    case 'config':
      return 'build';
    case 'up':
      return 'start';
    default:
      return 'unknown';
  }
}
