import { normalizePath } from './path';

/**
 * `normalizePath(path)`, or `undefined` for a path it rejects, for paths that come from an adapter and are
 * skipped when malformed.
 *
 * @example
 * ```ts
 * normalizedOrUndefined('a/../../b'); // undefined
 * ```
 */
export function normalizedOrUndefined(path: string): string | undefined {
  try {
    return normalizePath(path);
  } catch {
    return undefined;
  }
}
