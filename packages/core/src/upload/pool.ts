import { FsError } from '../errors';

/**
 * Runs `fn` over `items`, at most `limit` at a time. Never rejects; once `signal` aborts, unstarted items are
 * rejected as cancelled and in-flight ones are awaited.
 *
 * @example
 * ```ts
 * const results = await mapWithConcurrency(paths, 4, (path) => adapter.stat!(path));
 * ```
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      if (signal?.aborted) {
        results[index] = { status: 'rejected', reason: new FsError('cancelled') };
        continue;
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Shares `limit` slots between everything that runs through the returned function. A finished task hands its
 * slot straight to the next waiter, so no newcomer can slip in between.
 *
 * @example
 * ```ts
 * const gate = createGate(6);
 * await Promise.all(chunks.map((chunk) => gate(() => send(chunk))));
 * ```
 */
export function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const nextWaiter = waiting.shift();
      if (nextWaiter) nextWaiter();
      else active--;
    }
  };
}
