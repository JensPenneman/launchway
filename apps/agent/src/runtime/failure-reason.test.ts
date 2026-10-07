import { describe, expect, it } from 'vitest';
import { classifyFailure, isImageNotFound } from './failure-reason.js';

// Output captured from Docker Engine 27/28 with Compose v2 (classic and containerd image stores),
// BuildKit and GitHub Container Registry / Docker Hub.
const PULL_MISSING_TAG = [
  ' app Pulling ',
  ' app Error manifest unknown',
  'Error response from daemon: manifest unknown',
];
const PULL_MISSING_TAG_HUB = [
  ' web Pulling ',
  ' web Error manifest for nginx:does-not-exist not found: manifest unknown: manifest unknown',
  'Error response from daemon: manifest for nginx:does-not-exist not found: manifest unknown: manifest unknown',
];
const PULL_MISSING_REPOSITORY = [
  'Error response from daemon: repository ghcr.io/acme/trail not found: name unknown: repository name not known to registry',
];
const PULL_CONTAINERD_STORE = [
  ' app Error failed to resolve reference "ghcr.io/acme/trail:sha-3e560ee": ghcr.io/acme/trail:sha-3e560ee: not found',
  'Error response from daemon: failed to resolve reference "ghcr.io/acme/trail:sha-3e560ee": ghcr.io/acme/trail:sha-3e560ee: not found',
];
const PULL_PLAIN_404 = [
  'Error response from daemon: error parsing HTTP 404 response body: invalid character \'p\' after top-level value: "404 page not found\\n"',
];
const BUILD_MISSING_BASE = [
  '#2 [internal] load metadata for ghcr.io/acme/base:sha-3e560ee',
  '#2 ERROR: ghcr.io/acme/base:sha-3e560ee: not found',
  'failed to solve: ghcr.io/acme/base:sha-3e560ee: failed to resolve source metadata for ghcr.io/acme/base:sha-3e560ee: ghcr.io/acme/base:sha-3e560ee: not found',
];
const PULL_DENIED = [
  " app Error pull access denied for acme/private, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
  "Error response from daemon: pull access denied for acme/private, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
];
const PULL_UNAUTHORIZED = [
  'Error response from daemon: Head "https://ghcr.io/v2/acme/trail/manifests/sha-3e560ee": unauthorized',
];
const PULL_NETWORK = [
  'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
];
const BUILD_RUN_404 = [
  '#7 [3/5] RUN wget https://example.com/tool.tar.gz',
  '#7 0.412 HTTP request sent, awaiting response... 404 Not Found',
  '#7 0.413 2026-10-07 10:00:00 ERROR 404: Not Found.',
  'failed to solve: process "/bin/sh -c wget https://example.com/tool.tar.gz" did not complete successfully: exit code: 8',
];
const UP_UNHEALTHY = ['dependency failed to start: container launchway-trail-db-1 is unhealthy'];

describe('isImageNotFound', () => {
  it.each([
    ['a missing tag (ghcr)', PULL_MISSING_TAG],
    ['a missing tag (Docker Hub)', PULL_MISSING_TAG_HUB],
    ['a missing repository', PULL_MISSING_REPOSITORY],
    ['a missing tag (containerd image store)', PULL_CONTAINERD_STORE],
    ['a missing base image in a build', BUILD_MISSING_BASE],
  ])('recognises %s', (_, lines) => {
    expect(isImageNotFound(lines)).toBe(true);
  });

  it('counts a bare registry 404 only when asked to', () => {
    expect(isImageNotFound(PULL_PLAIN_404)).toBe(false);
    expect(isImageNotFound(PULL_PLAIN_404, { registry404: true })).toBe(true);
  });

  it.each([
    ['access denied', PULL_DENIED],
    ['unauthorized', PULL_UNAUTHORIZED],
    ['network errors', PULL_NETWORK],
    ['no output', []],
  ])('does not treat %s as a missing image', (_, lines) => {
    expect(isImageNotFound(lines, { registry404: true })).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('classifies missing images during pull and build', () => {
    expect(classifyFailure('pull', PULL_MISSING_TAG)).toBe('image-not-found');
    expect(classifyFailure('pull', PULL_CONTAINERD_STORE)).toBe('image-not-found');
    expect(classifyFailure('pull', PULL_PLAIN_404)).toBe('image-not-found');
    expect(classifyFailure('build', BUILD_MISSING_BASE)).toBe('image-not-found');
  });

  it('keeps other pull and build failures as build failures', () => {
    expect(classifyFailure('pull', PULL_DENIED)).toBe('build');
    expect(classifyFailure('pull', PULL_NETWORK)).toBe('build');
    expect(classifyFailure('build', BUILD_RUN_404)).toBe('build');
    expect(classifyFailure('build', PULL_PLAIN_404)).toBe('build');
  });

  it('maps the other steps', () => {
    expect(classifyFailure('checkout', ['fatal: Remote branch v9 not found'])).toBe('build');
    expect(classifyFailure('config', [])).toBe('build');
    expect(classifyFailure('up', UP_UNHEALTHY)).toBe('start');
    // A missing image at `up` cannot happen after a successful pull; it is a start failure.
    expect(classifyFailure('up', PULL_MISSING_TAG)).toBe('start');
    expect(classifyFailure('other', PULL_MISSING_TAG)).toBe('unknown');
  });
});
