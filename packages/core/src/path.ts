import { FsError } from './errors';

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ONLY_DOTS_AND_SPACES = /^[. ]+$/;

/**
 * Canonical form: NFC, `/`-separated, no leading/trailing slash, no `.`/`..`. Root is `''`.
 *
 * @example
 * ```ts
 * normalizePath('/src//app/./main.ts'); // 'src/app/main.ts'
 * ```
 */
export function normalizePath(path: string): string {
  if (path.includes('\0')) throw new FsError('invalid', 'path contains NUL', { path });
  if (path.includes('\\')) throw new FsError('invalid', 'path contains backslash', { path });
  if (UNPAIRED_SURROGATE.test(path)) throw new FsError('invalid', 'path contains invalid UTF-16', { path });
  const segments: string[] = [];
  for (const segment of path.normalize('NFC').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.pop() === undefined) throw new FsError('forbidden', 'path escapes root', { path });
    } else if (ONLY_DOTS_AND_SPACES.test(segment)) {
      throw new FsError('invalid', 'invalid path segment', { path });
    } else segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Joins path parts and normalizes the result.
 *
 * @example
 * ```ts
 * joinPath('src', 'app/main.ts'); // 'src/app/main.ts'
 * ```
 */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

/**
 * Join an untrusted relative path onto `base`; throws `forbidden` if the result leaves `base`.
 *
 * @example
 * ```ts
 * resolveUnder('uploads', 'photos/cat.png'); // 'uploads/photos/cat.png'
 * ```
 */
export function resolveUnder(base: string, relativePath: string): string {
  const normalizedBase = normalizePath(base);
  const resolved = normalizePath(`${normalizedBase}/${relativePath}`);
  if (!isSameOrDescendant(resolved, normalizedBase)) {
    throw new FsError('forbidden', 'path escapes base', { path: relativePath });
  }
  return resolved;
}

/**
 * The parent folder's path; `''` for top-level entries and for the root.
 *
 * @example
 * ```ts
 * parentPath('src/app/main.ts'); // 'src/app'
 * ```
 */
export function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

/**
 * The last path segment.
 *
 * @example
 * ```ts
 * basename('src/app/main.ts'); // 'main.ts'
 * ```
 */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Lowercase, no dot; `''` for dotfiles and extensionless names.
 *
 * @example
 * ```ts
 * extname('Report.PDF'); // 'pdf'
 * ```
 */
export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * How many segments a path has; the root `''` has depth 0.
 *
 * @example
 * ```ts
 * depthOf('src/app'); // 2
 * ```
 */
export function depthOf(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

/**
 * Whether `path` is `ancestor` or lies below it. Every path lies below the root `''`.
 *
 * @example
 * ```ts
 * isSameOrDescendant('src/app/main.ts', 'src'); // true
 * ```
 */
export function isSameOrDescendant(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(ancestor + '/');
}

/**
 * Moves `path` from below `from` to below `to`; paths outside `from` are returned unchanged.
 *
 * @example
 * ```ts
 * remapPrefix('old/a/b.ts', 'old', 'new'); // 'new/a/b.ts'
 * ```
 */
export function remapPrefix(path: string, from: string, to: string): string {
  if (!isSameOrDescendant(path, from)) return path;
  return joinPath(to, path.slice(from.length));
}
