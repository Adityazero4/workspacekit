import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { FsError, isSameOrDescendant, normalizePath, type Entry, type TransferOptions } from '@scope/core';
import { isInside, resolveInRoot, resolvesInside, toStoreError } from './jail';
import type { FileStore } from './store';
import { createWatcher } from './watch';

/** `.<name>.<12 hex>.tmp`, the staging files this store creates next to their target. */
const TMP = /^\..+\.[0-9a-f]{12}\.tmp$/;
const tmpSibling = (abs: string): string =>
  path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
/** Exclusion compares names NFC-normalized and case-folded, so `.GIT` and NFD spellings cannot slip past. */
const fold = (s: string): string => s.normalize('NFC').toLowerCase();

const orNull = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
};

/**
 * A `FileStore` over a directory tree. Every symlink on a path is resolved and must stay inside
 * the root; mutations and the open step of `read`, `stat`, and each directory step of `list`/`search`
 * run one at a time under a per-store lock, each re-resolving its path immediately before acting.
 *
 * Residual risk: a local process racing the server outside the HTTP API can still redirect a
 * single fs call (TOCTOU between the check and the syscall); acceptable for v1.
 */
export function nodeFsStore(root: string, opts: { exclude?: string[]; searchLimit?: number } = {}): FileStore {
  const excluded = new Set((opts.exclude ?? []).map(fold));
  const searchLimit = opts.searchLimit ?? 200;
  const isExcluded = (name: string): boolean => excluded.has(fold(name));
  const hidden = (name: string): boolean => isExcluded(name) || TMP.test(name);

  let rootP: Promise<string> | undefined;
  const getRoot = (): Promise<string> =>
    (rootP ??= realpath(root).catch(() => {
      rootP = undefined;
      throw new FsError('unknown', 'server root is unavailable');
    }));

  // ponytail: one global lock; shard per top-level directory if mutation throughput matters.
  // ponytail: a locked section reads one whole directory, so a single 100k-entry directory holds the lock for its
  // entire read; upgrade path: chunked readdir via opendir, releasing the lock between chunks.
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  const underExcluded = (R: string, abs: string): boolean => path.relative(R, abs).split(path.sep).some(isExcluded);
  const notFound = (rel: string): FsError => new FsError('not_found', `ENOENT: ${rel}`, { path: rel });

  /** `resolveInRoot` plus the exclude rule applied to where the path really lands. */
  async function resolve(R: string, rel: string, forCreate = false): Promise<string> {
    const abs = await resolveInRoot(R, rel, { forCreate });
    const real = await realpath(abs).catch(() => abs);
    if (underExcluded(R, abs) || underExcluded(R, real)) throw notFound(rel);
    return abs;
  }

  /** Entry for a path on disk; null if missing, special, a link leaving the root, or a link that cannot be resolved. */
  async function entryAt(R: string, abs: string, rel: string): Promise<Entry | null> {
    let st = await orNull(lstat(abs));
    if (st?.isSymbolicLink()) {
      try {
        const real = await realpath(abs);
        if (!isInside(R, real) || underExcluded(R, real)) return null;
        st = await stat(real);
      } catch {
        return null;
      }
    }
    if (!st || !(st.isFile() || st.isDirectory())) return null;
    const dir = st.isDirectory();
    return {
      path: rel,
      name: path.basename(rel),
      kind: dir ? 'directory' : 'file',
      size: dir ? null : st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    };
  }

  /** Entry for something this store just created or moved: never null. A link that does not resolve inside the root reports as a file. */
  async function createdEntry(R: string, abs: string, rel: string): Promise<Entry> {
    const l = await lstat(abs);
    let st = l;
    if (l.isSymbolicLink()) {
      try {
        const real = await realpath(abs);
        if (isInside(R, real)) st = await stat(real);
      } catch {
        // keep the link's own stat
      }
    }
    const dir = st.isDirectory();
    return {
      path: rel,
      name: path.basename(rel),
      kind: dir ? 'directory' : 'file',
      size: dir ? null : st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    };
  }

  /**
   * Breadth-first descendants of `abs` (a real path) down to `depth` levels; the start itself is
   * excluded. Each directory is read and its entries built in one locked section, after checking
   * that it is still the real directory it was queued as, so a concurrent move cannot swap a
   * queued directory for a link that leaves the root. Sections are one directory long, so big
   * walks do not starve mutations.
   *
   * A directory that should be walked but is not (a link to a directory, unreadable, or swapped
   * since it was queued) gets `meta: { incomplete: true }`, so clients do not take it as empty.
   */
  async function* bfs(R: string, rel: string, abs: string, depth: number): AsyncGenerator<Entry> {
    let level: { rel: string; abs: string; entry?: Entry }[] = [{ rel, abs }];
    for (let d = 0; d < depth && level.length > 0; d++) {
      const next: typeof level = [];
      for (const dir of level) {
        const found = await locked(async () => {
          const real = await realpath(dir.abs).catch(() => null);
          if (real !== dir.abs || !isInside(R, real)) {
            if (d === 0) throw notFound(dir.rel);
            return null; // swapped or removed since it was queued
          }
          let items;
          try {
            items = await readdir(dir.abs, { withFileTypes: true });
          } catch (e) {
            if (d === 0) throw e;
            return null; // an unreadable subdirectory is skipped, not fatal
          }
          const out: { entry: Entry; dir?: string }[] = [];
          for (const it of items) {
            const name = it.name.normalize('NFC');
            if (hidden(name)) continue;
            const childRel = dir.rel ? `${dir.rel}/${name}` : name;
            const childAbs = path.join(dir.abs, it.name);
            const entry = await entryAt(R, childAbs, childRel);
            if (entry) out.push({ entry, dir: it.isDirectory() ? childAbs : undefined });
          }
          return out;
        });
        // Already yielded; the mark still lands before `list` returns, as it collects the whole walk first.
        if (!found && dir.entry) dir.entry.meta = { incomplete: true };
        for (const f of found ?? []) {
          if (!f.dir && f.entry.kind === 'directory' && d + 1 < depth) f.entry.meta = { incomplete: true }; // a link: not walked
          yield f.entry;
          if (f.dir) next.push({ rel: f.entry.path, abs: f.dir, entry: f.entry });
        }
      }
      level = next;
    }
  }

  const visible = (rel: string): void => {
    if (rel.split('/').some(isExcluded)) throw notFound(rel);
  };
  const nonRoot = (rel: string): void => {
    if (rel === '') throw new FsError('invalid', 'operation not allowed on the root', { path: rel });
  };
  /** Normalizes `p`, hides excluded names, and turns node errors into `FsError`s naming `rel`. */
  async function op<T>(p: string, fn: (rel: string, R: string) => Promise<T>, exclusive = false): Promise<T> {
    const rel = normalizePath(p);
    visible(rel);
    try {
      const R = await getRoot();
      return await (exclusive ? locked(() => fn(rel, R)) : fn(rel, R));
    } catch (e) {
      throw toStoreError(e, rel);
    }
  }

  /** A link being moved/copied to `dst` must still resolve inside the root from its new home. */
  async function assertLinkStaysInside(R: string, src: string, dst: string, rel: string): Promise<void> {
    const target = await readlink(src);
    const segs = target.split('/');
    // `link/..` is resolved by the OS after following `link`, which a lexical check cannot model.
    const ambiguous = segs.some((s, i) => s === '..' && segs.slice(0, i).some((p) => p !== '' && p !== '..'));
    if (ambiguous || !(await resolvesInside(R, path.resolve(path.dirname(dst), target)))) {
      throw new FsError('forbidden', `link would leave the root: ${rel}`, { path: rel });
    }
  }

  async function transfer(kind: 'move' | 'copy', from: string, to: string, o: TransferOptions = {}): Promise<Entry> {
    const t = normalizePath(to);
    visible(t);
    return op(
      from,
      async (f, R) => {
        nonRoot(f);
        nonRoot(t);
        const src = await resolve(R, f);
        if (f === t) return createdEntry(R, src, f);
        if (isSameOrDescendant(t, f) || isSameOrDescendant(f, t)) {
          throw new FsError('invalid', `cannot ${kind} a folder into itself`, { path: f });
        }
        const dst = await resolve(R, t, true);
        const srcSt = await lstat(src);
        if (srcSt.isSymbolicLink()) await assertLinkStaysInside(R, src, dst, f);
        const dstSt = await orNull(lstat(dst));
        // Same inode: a case-only rename on a case-insensitive filesystem, or a hard link.
        const same = !!dstSt && dstSt.ino === srcSt.ino && dstSt.dev === srcSt.dev;
        if (dstSt && !same && !o.overwrite) throw new FsError('conflict', `EEXIST: ${t}`, { path: t });
        await mkdir(path.dirname(dst), { recursive: true });
        if (same) {
          if (kind === 'move') await rename(src, dst);
          return createdEntry(R, dst, t);
        }
        // A copy over an existing destination is staged next to it, so a failed copy loses nothing.
        let staged = src;
        if (kind === 'copy') {
          staged = dstSt ? tmpSibling(dst) : dst;
          try {
            await cp(src, staged, {
              recursive: true,
              errorOnExist: !o.overwrite,
              force: !!o.overwrite,
              verbatimSymlinks: true,
              filter: (s) => !hidden(path.basename(s)),
            });
          } catch (e) {
            await rm(staged, { recursive: true, force: true }).catch(() => {});
            throw e;
          }
        }
        if (kind === 'move' || staged !== dst) {
          try {
            // Plain files replace atomically on rename; anything involving a directory is removed first.
            if (dstSt && (srcSt.isDirectory() || dstSt.isDirectory())) await rm(dst, { recursive: true, force: true });
            await rename(staged, dst);
          } catch (e) {
            if (kind === 'copy') await rm(staged, { recursive: true, force: true }).catch(() => {});
            throw e;
          }
        }
        return createdEntry(R, dst, t);
      },
      true,
    );
  }

  const subscribe = createWatcher({
    root: path.resolve(root),
    hiddenName: hidden,
    // Gone -> null; hidden, special or escaping -> undefined. The OS-reported name is used on disk (it may not be NFC).
    async probe(rel, raw) {
      const R = await getRoot();
      const abs = path.join(R, raw);
      const dir = await orNull(realpath(path.dirname(abs)));
      if (dir === null) return null;
      if (!isInside(R, dir) || underExcluded(R, dir)) return undefined;
      const l = await orNull(lstat(abs));
      if (!l) return null;
      const e = await entryAt(R, abs, rel);
      return e ? { mtimeMs: e.mtimeMs ?? 0, birthMs: l.birthtimeMs } : undefined;
    },
  });

  return {
    watch: subscribe,

    list: (p, depth) =>
      op(p, async (rel, R) => {
        const abs = await locked(async () => {
          const real = await realpath(await resolve(R, rel));
          if (!(await stat(real)).isDirectory()) throw new FsError('invalid', `not a directory: ${rel}`, { path: rel });
          return real;
        });
        const out: Entry[] = [];
        for await (const e of bfs(R, rel, abs, Math.floor(depth))) out.push(e);
        return out;
      }),

    stat: (p) =>
      op(p, (rel, R) => locked(async () => entryAt(R, await resolve(R, rel), rel))).catch((e: unknown) => {
        if (e instanceof FsError && e.kind === 'not_found') return null;
        throw e;
      }),

    read: (p, range) =>
      op(p, async (rel, R) => {
        // Resolve and open under the lock; the opened handle then streams without it.
        const o = await locked(async () => {
          const abs = await resolve(R, rel);
          const st = await stat(abs);
          if (st.isDirectory()) throw new FsError('invalid', `is a directory: ${rel}`, { path: rel });
          const entry = (await entryAt(R, abs, rel)) ?? (() => { throw notFound(rel); })();
          let start: number | undefined;
          let end: number | undefined;
          if (range) {
            ({ start } = range);
            if (!Number.isInteger(start) || !Number.isInteger(range.end) || start < 0 || range.end < start || start >= st.size) {
              throw new FsError('invalid', `unsatisfiable range: ${rel}`, { path: rel });
            }
            end = Math.min(range.end, st.size - 1);
          }
          const size = range ? end! - start! + 1 : st.size;
          return { entry, start, end, size, fh: await open(abs, 'r') };
        });
        const body = Readable.toWeb(o.fh.createReadStream({ start: o.start, end: o.end })) as unknown as ReadableStream<Uint8Array>;
        return { body, size: o.size, entry: o.entry };
      }),

    write: (p, data, o = {}) =>
      op(p, async (rel, R) => {
        nonRoot(rel);
        // Conflict rules; returns the file the staged bytes must replace (through a file symlink, not over it).
        const check = async (abs: string): Promise<string> => {
          const st = await orNull(stat(abs));
          if (st?.isDirectory()) throw new FsError('conflict', `EISDIR: ${rel}`, { path: rel });
          if (st && o.overwrite === false) throw new FsError('conflict', `EEXIST: ${rel}`, { path: rel });
          if (o.expectedMtimeMs !== undefined && (!st || Math.floor(st.mtimeMs) !== o.expectedMtimeMs)) {
            throw new FsError('conflict', `file changed: ${rel}`, { path: rel });
          }
          return st ? realpath(abs) : abs;
        };
        const staged = await locked(async () => {
          const abs = await resolve(R, rel, true);
          await check(abs);
          await mkdir(path.dirname(abs), { recursive: true });
          const dir = await realpath(path.dirname(abs));
          if (!isInside(R, dir)) throw new FsError('forbidden', 'path escapes root', { path: rel });
          const tmp = tmpSibling(path.join(dir, path.basename(abs)));
          return { dir, tmp, fh: await open(tmp, 'wx') };
        });
        const { dir, tmp, fh } = staged;
        try {
          const max = o.maxBytes;
          const tooLarge = (): FsError => new FsError('too_large', `exceeds ${max} bytes: ${rel}`, { path: rel });
          if (data instanceof Uint8Array) {
            try {
              if (max !== undefined && data.byteLength > max) throw tooLarge();
              await fh.writeFile(data);
            } finally {
              await fh.close();
            }
          } else {
            let n = 0;
            await pipeline(
              Readable.fromWeb(data as unknown as NodeWebStream<Uint8Array>),
              async function* (src: AsyncIterable<Uint8Array>) {
                for await (const chunk of src) {
                  n += chunk.byteLength;
                  if (max !== undefined && n > max) throw tooLarge();
                  yield chunk;
                }
              },
              fh.createWriteStream(),
            );
          }
          // The upload may have been slow: re-resolve, make sure nothing moved under us, then commit.
          return await locked(async () => {
            const abs = await resolve(R, rel, true);
            const here = await realpath(path.dirname(abs));
            const tmpDir = await realpath(path.dirname(tmp));
            if (!isInside(R, here) || !isInside(R, tmpDir)) throw new FsError('forbidden', 'path escapes root', { path: rel });
            if (here !== dir || tmpDir !== dir) throw new FsError('conflict', `directory changed during write: ${rel}`, { path: rel });
            const dest = await check(abs);
            if (!isInside(R, dest)) throw new FsError('forbidden', 'path escapes root', { path: rel });
            if (underExcluded(R, dest)) throw notFound(rel);
            await rename(tmp, dest);
            return createdEntry(R, abs, rel);
          });
        } catch (e) {
          await rm(tmp, { force: true }).catch(() => {});
          throw e;
        }
      }),

    create: (p, kind) =>
      op(
        p,
        async (rel, R) => {
          nonRoot(rel);
          const abs = await resolve(R, rel, true);
          if (await orNull(lstat(abs))) throw new FsError('conflict', `EEXIST: ${rel}`, { path: rel });
          await mkdir(path.dirname(abs), { recursive: true });
          if (kind === 'directory') await mkdir(abs);
          else await writeFile(abs, '', { flag: 'wx' });
          return createdEntry(R, abs, rel);
        },
        true,
      ),

    move: (from, to, o) => transfer('move', from, to, o),
    copy: (from, to, o) => transfer('copy', from, to, o),

    delete: (p) =>
      op(
        p,
        async (rel, R) => {
          nonRoot(rel);
          await rm(await resolve(R, rel), { recursive: true });
        },
        true,
      ),

    // ponytail: walks the whole tree per query; add an index if roots get large.
    search: (query, limit) =>
      op('', async (rel, R) => {
        const q = query.normalize('NFC').toLowerCase(); // names from bfs are NFC
        const max = Math.min(limit, searchLimit);
        const out: Entry[] = [];
        if (!q || max < 1) return out;
        for await (const e of bfs(R, rel, R, Infinity)) {
          if (!e.name.toLowerCase().includes(q)) continue;
          out.push(e);
          if (out.length >= max) break;
        }
        return out;
      }),
  };
}
