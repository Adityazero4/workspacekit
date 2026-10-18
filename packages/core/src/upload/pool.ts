import { FsError } from '../errors';

/** Runs `fn` over `items`, at most `limit` at a time. Never rejects; once `signal` aborts, unstarted items are rejected as cancelled and in-flight ones are awaited. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      if (signal?.aborted) {
        results[i] = { status: 'rejected', reason: new FsError('cancelled') };
        continue;
      }
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i] as T, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Shares `limit` slots between everything that runs through the returned function. */
export function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter so no newcomer can slip in between.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
