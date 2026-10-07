import type { GitHubRelease } from '@launchway/contracts';

/** Newest published, non-draft release; prereleases only when nothing else exists. */
export function latestRelease(releases: readonly GitHubRelease[]): GitHubRelease | undefined {
  const published = releases.filter((release) => !release.draft);
  return published.find((release) => !release.prerelease) ?? published[0];
}
