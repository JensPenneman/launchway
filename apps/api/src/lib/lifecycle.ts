/** Process lifecycle shared with modules: long-lived work stops when `signal` aborts. */
export interface Lifecycle {
  readonly signal: AbortSignal;
  readonly shuttingDown: boolean;
  beginShutdown(): void;
}

export function createLifecycle(): Lifecycle {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    get shuttingDown() {
      return controller.signal.aborted;
    },
    beginShutdown() {
      controller.abort();
    },
  };
}
