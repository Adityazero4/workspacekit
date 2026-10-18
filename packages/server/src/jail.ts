import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { FsError, isFsError, normalizePath, type FsErrorKind } from '@scope/core';

const KIND: Record<string, FsErrorKind> = {
  ENOENT: 'not_found',
  EEXIST: 'conflict',
  ENOTDIR: 'conflict',
  EISDIR: 'conflict',
  ENOTEMPTY: 'conflict',
  ERR_FS_CP_EEXIST: 'conflict',
  EACCES: 'forbidden',
  EPERM: 'forbidden',
  ELOOP: 'forbidden',
  EINVAL: 'invalid',
  ERR_FS_CP_EINVAL: 'invalid',
  ENAMETOOLONG: 'invalid',
};

/** Maps a node error to an `FsError` whose message names only the relative path. */
export function toStoreError(e: unknown, rel: string): FsError {
  if (isFsError(e)) return e;
  const code = String((e as { code?: unknown } | null)?.code ?? 'EIO');
  const kind = KIND[code] ?? 'unknown';
  return new FsError(kind, `${code}: ${rel || '/'}`, { path: rel });
}

/** True when `p` is `rootReal` or lies inside it. */
export function isInside(rootReal: string, p: string): boolean {
  const base = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return p === rootReal || p.startsWith(base);
}

/** Real path of the deepest existing ancestor of `abs`, plus the missing tail below it. */
async function deepestReal(abs: string): Promise<{ real: string; tail: string[] }> {
  const tail: string[] = [];
  for (let cur = abs; ; ) {
    try {
      return { real: await realpath(cur), tail };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') {
        // A dangling symlink could point anywhere, so never write through one.
        const link = await lstat(cur).then((s) => s.isSymbolicLink(), () => false);
        if (link) throw new FsError('forbidden', 'dangling symlink');
      } else if (code !== 'ENOTDIR') throw e;
      const up = path.dirname(cur);
      if (up === cur) throw e;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** True when `abs` (which may not exist yet) resolves through every symlink to a place inside the root. */
export async function resolvesInside(rootReal: string, abs: string): Promise<boolean> {
  const { real, tail } = await deepestReal(abs);
  return isInside(rootReal, path.join(real, ...tail));
}

/**
 * Resolves an untrusted relative path to an absolute one inside `rootReal` (already a realpath).
 * Every symlink on the way is resolved and must stay inside the root. A final symlink is
 * checked but not followed in the result, so deleting or moving it affects the link itself.
 * Without `forCreate` the path must exist (`not_found`); with it only the deepest existing
 * ancestor is checked.
 */
export async function resolveInRoot(
  rootReal: string,
  relPath: string,
  opts: { forCreate?: boolean } = {},
): Promise<string> {
  if (relPath.startsWith('/')) throw new FsError('forbidden', 'absolute paths are not allowed', { path: relPath });
  const rel = normalizePath(relPath);
  if (rel === '') return rootReal;
  try {
    const abs = path.join(rootReal, ...rel.split('/'));
    const { real, tail } = await deepestReal(abs);
    const full = path.join(real, ...tail);
    if (!isInside(rootReal, full)) throw new FsError('forbidden', 'path escapes root', { path: rel });
    if (tail.length > 0) {
      if (!opts.forCreate) throw new FsError('not_found', `ENOENT: ${rel}`, { path: rel });
      return full;
    }
    const out = path.join(await realpath(path.dirname(abs)), path.basename(abs));
    if (!isInside(rootReal, out)) throw new FsError('forbidden', 'path escapes root', { path: rel });
    return out;
  } catch (e) {
    throw toStoreError(e, rel);
  }
}
