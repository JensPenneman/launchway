import type { AgentToServerMessage } from '@launchway/contracts';

export type Send = (message: AgentToServerMessage) => void;

/** Streaming messages that are worthless after a reconnect; everything else is kept. */
const DROPPABLE: ReadonlySet<AgentToServerMessage['type']> = new Set([
  'deployment.log',
  'logs.chunk',
  'heartbeat',
]);

/**
 * Sends while connected; while disconnected keeps results, progress, status and errors (bounded)
 * and delivers them after the next `hello.ok`, so a reconnect does not lose a deployment result.
 */
export class Outbox {
  readonly #trySend: (message: AgentToServerMessage) => boolean;
  readonly #max: number;
  readonly #pending: AgentToServerMessage[] = [];

  constructor(trySend: (message: AgentToServerMessage) => boolean, max = 500) {
    this.#trySend = trySend;
    this.#max = max;
  }

  readonly send: Send = (message) => {
    if (this.#pending.length === 0 && this.#trySend(message)) return;
    if (DROPPABLE.has(message.type)) return;
    this.#pending.push(message);
    if (this.#pending.length > this.#max) this.#pending.shift();
  };

  /** Call after the handshake completed. */
  flush(): void {
    while (this.#pending.length > 0) {
      const next = this.#pending[0];
      if (!next || !this.#trySend(next)) return;
      this.#pending.shift();
    }
  }

  get pending(): number {
    return this.#pending.length;
  }
}
