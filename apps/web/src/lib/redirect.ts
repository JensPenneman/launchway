/** Only same-origin paths are accepted as post-login targets (no open redirects). */
export function safeRedirect(value: unknown): string | undefined {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : undefined;
}
