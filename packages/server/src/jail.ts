import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { FsError, isFsError, normalizePath, type FsErrorKind } from '@scope/core';

const KIND_BY_NODE_ERROR_CODE: Record<string, FsErrorKind> = {
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

/**
 * Maps a node error to an `FsError` whose message names only the relative path.
 *
 * @example
 * await rm(abs).catch((error: unknown) => Promise.reject(toStoreError(error, 'src/a.ts')));
 */
export function toStoreError(error: unknown, rel: string): FsError {
  if (isFsError(error)) return error;
  const code = (error as { code?: string } | null)?.code ?? 'EIO';
  const kind = KIND_BY_NODE_ERROR_CODE[code] ?? 'unknown';
  return new FsError(kind, `${code}: ${rel || '/'}`, { path: rel });
}

/**
 * True when `p` is `rootReal` or lies inside it.
 *
 * @example
 * isInside('/srv/root', '/srv/root/src'); // true
 */
export function isInside(rootReal: string, p: string): boolean {
  const base = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return p === rootReal || p.startsWith(base);
}

async function isDanglingSymlink(abs: string): Promise<boolean> {
  return lstat(abs).then(
    (stats) => stats.isSymbolicLink(),
    () => false,
  );
}

async function deepestExistingRealPath(abs: string): Promise<{ real: string; missingTail: string[] }> {
  const missingTail: string[] = [];
  for (let candidate = abs; ;) {
    try {
      return { real: await realpath(candidate), missingTail };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        if (await isDanglingSymlink(candidate)) throw new FsError('forbidden', 'dangling symlink');
      } else if (code !== 'ENOTDIR') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingTail.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * True when `abs` (which may not exist yet) resolves through every symlink to a place inside the root.
 *
 * @example
 * if (!(await resolvesInside(rootReal, linkTarget))) throw new FsError('forbidden');
 */
export async function resolvesInside(rootReal: string, abs: string): Promise<boolean> {
  const { real, missingTail } = await deepestExistingRealPath(abs);
  return isInside(rootReal, path.join(real, ...missingTail));
}

/**
 * Resolves an untrusted relative path to an absolute one inside `rootReal` (already a realpath).
 * Every symlink on the way is resolved and must stay inside the root. A final symlink is
 * checked but not followed in the result, so deleting or moving it affects the link itself.
 * Without `forCreate` the path must exist (`not_found`); with it only the deepest existing
 * ancestor is checked.
 *
 * @example
 * const abs = await resolveInRoot(await realpath('/srv/root'), 'src/main.ts');
 */
export async function resolveInRoot(
  rootReal: string,
  relPath: string,
  opts: { forCreate?: boolean } = {},
): Promise<string> {
  if (relPath.startsWith('/')) {
    throw new FsError('forbidden', 'absolute paths are not allowed', { path: relPath });
  }
  const rel = normalizePath(relPath);
  if (rel === '') return rootReal;
  try {
    const abs = path.join(rootReal, ...rel.split('/'));
    const { real, missingTail } = await deepestExistingRealPath(abs);
    const full = path.join(real, ...missingTail);
    if (!isInside(rootReal, full)) throw new FsError('forbidden', 'path escapes root', { path: rel });
    if (missingTail.length > 0) {
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
