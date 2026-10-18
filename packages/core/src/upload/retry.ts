import { FsError, toFsError } from '../errors';

export function isTransient(e: FsError): boolean {
  return e.kind === 'network' || e.kind === 'timeout' || e.status === 502 || e.status === 503 || e.status === 504;
}

/** Resolves after `ms`; rejects at once with `cancelled` if `signal` aborts first. */
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

/** Runs `fn`, retrying retryable errors after each delay in `delaysMs` (so at most `delaysMs.length + 1` attempts). */
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
    } catch (e) {
      const err = toFsError(e);
      const delay = delaysMs[attempt];
      if (delay === undefined || err.kind === 'cancelled' || !isRetryable(err)) throw err;
      await backoff(delay, signal);
    }
  }
}
