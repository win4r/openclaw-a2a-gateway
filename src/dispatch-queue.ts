/**
 * Per-key dispatch queue for serializing concurrent async operations.
 *
 * Used by the A2A gateway executor to serialize tasks sharing the same
 * contextId, preventing race conditions on the session .jsonl file.
 *
 * @see https://github.com/win4r/openclaw-a2a-gateway/issues/81
 */

/**
 * Enqueue an async operation so it runs after any pending operation for the
 * same key has settled. Operations for different keys run concurrently.
 *
 * - Failure isolation: a rejected predecessor does not cascade.
 * - Cleanup: the map entry is removed when the chain settles.
 *
 * @param queues  Shared map of key → tail promise
 * @param key     Queue key (e.g. contextId)
 * @param fn      The async operation to enqueue
 * @returns       Result of `fn`, after serialization
 */
export function enqueueDispatch<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();

  let resolveDispatch: (value: T) => void;
  let rejectDispatch: (error: unknown) => void;
  const resultPromise = new Promise<T>((resolve, reject) => {
    resolveDispatch = resolve;
    rejectDispatch = reject;
  });

  // Chain: swallow predecessor errors so one failure doesn't cascade
  const chain = previous.catch(() => {}).then(async () => {
    try {
      const result = await fn();
      resolveDispatch(result);
    } catch (err) {
      rejectDispatch(err);
    }
  });

  queues.set(key, chain);

  // Cleanup: remove entry if this is still the tail promise
  chain
    .finally(() => {
      if (queues.get(key) === chain) {
        queues.delete(key);
      }
    })
    .catch(() => {}); // suppress unhandled rejection on cleanup

  return resultPromise;
}
