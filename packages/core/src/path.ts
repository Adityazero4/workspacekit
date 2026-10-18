import { FsError } from './errors';

/** A high surrogate without a following low one, or a low surrogate without a preceding high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Canonical form: NFC, `/`-separated, no leading/trailing slash, no `.`/`..`. Root is `''`. */
export function normalizePath(p: string): string {
  if (p.includes('\0')) throw new FsError('invalid', 'path contains NUL', { path: p });
  if (p.includes('\\')) throw new FsError('invalid', 'path contains backslash', { path: p });
  if (LONE_SURROGATE.test(p)) throw new FsError('invalid', 'path contains invalid UTF-16', { path: p });
  const out: string[] = [];
  for (const seg of p.normalize('NFC').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.pop() === undefined) throw new FsError('forbidden', 'path escapes root', { path: p });
    } else if (/^[. ]+$/.test(seg)) {
      throw new FsError('invalid', 'invalid path segment', { path: p });
    } else out.push(seg);
  }
  return out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

/** Join an untrusted relative path onto `base`; throws `forbidden` if the result leaves `base`. */
export function resolveUnder(base: string, rel: string): string {
  const b = normalizePath(base);
  const r = normalizePath(`${b}/${rel}`);
  if (!isSameOrDescendant(r, b)) throw new FsError('forbidden', 'path escapes base', { path: rel });
  return r;
}

export function parentPath(p: string): string {
  return p.slice(0, Math.max(0, p.lastIndexOf('/')));
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Lowercase, no dot; `''` for dotfiles and extensionless names. */
export function extname(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function depthOf(p: string): number {
  return p === '' ? 0 : p.split('/').length;
}

export function isSameOrDescendant(p: string, ancestor: string): boolean {
  return ancestor === '' || p === ancestor || p.startsWith(ancestor + '/');
}

export function remapPrefix(p: string, from: string, to: string): string {
  if (!isSameOrDescendant(p, from)) return p;
  return joinPath(to, p.slice(from.length));
}
