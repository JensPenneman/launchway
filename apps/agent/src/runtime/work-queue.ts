/**
 * Tasks in arrival order, of two kinds: shared tasks run side by side, an exclusive task runs
 * alone. An exclusive task waits for the shared tasks that started before it, and the tasks that
 * arrive after it wait for it; nothing overtakes a waiting task, so an exclusive task is never
 * starved. Tasks start asynchronously (never inside `shared` or `exclusive`); a task that fails
 * is passed to `onError` and the queue goes on.
 */
export class WorkQueue {
  readonly #onError: (error: unknown) => void;
  readonly #waiting: { exclusive: boolean; start: () => void }[] = [];
  readonly #pending = new Set<Promise<void>>();
  #shared = 0;
  #exclusive = false;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  /** Runs `task` beside the other shared tasks, once the exclusive tasks before it ended. */
  shared(task: () => Promise<void>): void {
    this.#add(false, task);
  }

  /** Runs `task` alone, once every task before it ended. */
  exclusive(task: () => Promise<void>): void {
    this.#add(true, task);
  }

  /** Resolves once every task added so far, and every task they added, has ended. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  #add(exclusive: boolean, task: () => Promise<void>): void {
    const done = new Promise<void>((resolve) => {
      this.#waiting.push({
        exclusive,
        start: () => {
          Promise.resolve()
            .then(task)
            .catch(this.#onError)
            .finally(() => {
              if (exclusive) this.#exclusive = false;
              else this.#shared -= 1;
              resolve();
              this.#next();
            });
        },
      });
    });
    this.#pending.add(done);
    void done.then(() => this.#pending.delete(done));
    queueMicrotask(() => this.#next());
  }

  #next(): void {
    for (;;) {
      const head = this.#waiting[0];
      if (!head || this.#exclusive || (head.exclusive && this.#shared > 0)) return;
      this.#waiting.shift();
      if (head.exclusive) this.#exclusive = true;
      else this.#shared += 1;
      head.start();
    }
  }
}
