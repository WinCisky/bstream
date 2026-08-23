/** Small async helpers. Nothing here throws on its own. */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Resolves with `null` when the signal aborts. Used to race work against a deadline. */
export function whenAborted(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

/**
 * Collapse concurrent calls for the same key onto one in-flight operation.
 *
 * Twenty simultaneous requests for the same magnet should join one swarm and produce one KV write,
 * not twenty of each.
 */
export class SingleFlight<T> {
  readonly #inFlight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const task = work().finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, task);
    return task;
  }

  get size(): number {
    return this.#inFlight.size;
  }
}
