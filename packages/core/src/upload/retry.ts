import { FsError, toFsError } from '../errors';

/**
 * Whether retrying may fix `error`: network failures, timeouts and 502/503/504 responses.
 *
 * @example
 * ```ts
 * if (isTransient(error)) scheduleRetry();
 * ```
 */
export function isTransient(error: FsError): boolean {
  const { kind, status } = error;
  return kind === 'network' || kind === 'timeout' || status === 502 || status === 503 || status === 504;
}

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new FsError('cancelled'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new FsError('cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `fn`, retrying retryable errors after each delay in `delaysMs` (so at most `delaysMs.length + 1`
 * attempts).
 *
 * @example
 * ```ts
 * const entry = await withRetry(() => transport.complete(uploadId), [1000, 2000, 4000], signal);
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[],
  signal?: AbortSignal,
  isRetryable: (e: FsError) => boolean = isTransient,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new FsError('cancelled');
    try {
      return await fn();
    } catch (thrown) {
      const error = toFsError(thrown);
      const delay = delaysMs[attempt];
      if (delay === undefined || error.kind === 'cancelled' || !isRetryable(error)) throw error;
      await backoff(delay, signal);
    }
  }
}
