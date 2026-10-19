/**
 * What went wrong, independent of transport. HTTP statuses map to kinds through `kindForStatus`.
 *
 * @example
 * ```ts
 * if (error.kind === 'conflict') askToOverwrite();
 * ```
 */
export type FsErrorKind =
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'too_large'
  | 'invalid'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

/**
 * The one error type every adapter, store and handler throws. `path` names the entry the failure concerns.
 *
 * @example
 * ```ts
 * throw new FsError('not_found', `not found: ${path}`, { path });
 * ```
 */
export class FsError extends Error {
  /** What went wrong. */
  kind: FsErrorKind;
  /** The HTTP status, when the error came from a response. */
  status?: number;
  /** The entry the failure concerns, when there is one. */
  path?: string;
  constructor(
    kind: FsErrorKind,
    message?: string,
    opts: { status?: number; path?: string; cause?: unknown } = {},
  ) {
    super(message ?? kind, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'FsError';
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.path !== undefined) this.path = opts.path;
  }
}

/**
 * Whether `error` is an `FsError`.
 *
 * @example
 * ```ts
 * if (isFsError(error) && error.kind === 'cancelled') return;
 * ```
 */
export function isFsError(error: unknown): error is FsError {
  return error instanceof FsError;
}

const isFetchNetworkFailure = (error: Error): boolean => error instanceof TypeError;

/**
 * Converts anything thrown into an `FsError`: aborts become `cancelled`, fetch network failures (`TypeError`)
 * become `network`, and everything else `unknown`, keeping the original as `cause`.
 *
 * @example
 * ```ts
 * adapter.list('src', { depth: 1 }).catch((error: unknown) => report(toFsError(error)));
 * ```
 */
export function toFsError(error: unknown): FsError {
  if (isFsError(error)) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return new FsError('cancelled', error.message, { cause: error });
    if (isFetchNetworkFailure(error)) return new FsError('network', error.message, { cause: error });
    return new FsError('unknown', error.message, { cause: error });
  }
  return new FsError('unknown', String(error), { cause: error });
}

const STATUS_BY_KIND: Partial<Record<FsErrorKind, number>> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unknown: 500,
  timeout: 504,
};

/**
 * The HTTP status the server answers for an error kind (500 for kinds without one).
 *
 * @example
 * ```ts
 * statusForKind('not_found'); // 404
 * ```
 */
export function statusForKind(kind: FsErrorKind): number {
  return STATUS_BY_KIND[kind] ?? 500;
}

/**
 * The error kind for an HTTP status (401 and 403 are both `forbidden`, 408 and 504 `timeout`).
 *
 * @example
 * ```ts
 * kindForStatus(409); // 'conflict'
 * ```
 */
export function kindForStatus(status: number): FsErrorKind {
  switch (status) {
    case 400:
      return 'invalid';
    case 401:
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 408:
    case 504:
      return 'timeout';
    case 409:
      return 'conflict';
    case 413:
      return 'too_large';
    default:
      return 'unknown';
  }
}
