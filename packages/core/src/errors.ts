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

export class FsError extends Error {
  kind: FsErrorKind;
  status?: number;
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

export function isFsError(e: unknown): e is FsError {
  return e instanceof FsError;
}

export function toFsError(e: unknown): FsError {
  if (isFsError(e)) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new FsError('cancelled', e.message, { cause: e });
    // fetch rejects with TypeError on network failure
    if (e instanceof TypeError) return new FsError('network', e.message, { cause: e });
    return new FsError('unknown', e.message, { cause: e });
  }
  return new FsError('unknown', String(e), { cause: e });
}

const STATUS: Partial<Record<FsErrorKind, number>> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unknown: 500,
  timeout: 504,
};

export function statusForKind(kind: FsErrorKind): number {
  return STATUS[kind] ?? 500;
}

export function kindForStatus(status: number): FsErrorKind {
  switch (status) {
    case 400: return 'invalid';
    case 401:
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 408:
    case 504: return 'timeout';
    case 409: return 'conflict';
    case 413: return 'too_large';
    default: return 'unknown';
  }
}
