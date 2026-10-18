import { FsError } from '../errors';
import { basename, depthOf, isSameOrDescendant, normalizePath, parentPath, remapPrefix } from '../path';
import type { ChangeEvent, Entry, EntryKind, FileSystemAdapter } from '../types';

type Bytes = Uint8Array<ArrayBuffer>;
interface Node {
  kind: EntryKind;
  data?: Bytes;
  mtimeMs: number;
}
interface Session {
  path: string;
  total: number;
  overwrite: boolean;
  buf: Bytes;
  parts: Map<number, number>;
}

export interface MemoryAdapterOptions {
  files?: Record<string, string | Uint8Array>;
  /** Artificial delay applied to every call. */
  latencyMs?: number;
  /** Chunk size reported by `upload.chunked.init`. */
  chunkSize?: number;
}
export type MemoryAdapter = FileSystemAdapter & { emit(events: ChangeEvent[]): void };

const enc = new TextEncoder();
const dec = new TextDecoder();
const cancelled = (): FsError => new FsError('cancelled');
const byPath = (a: Entry, b: Entry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function createMemoryAdapter(opts: MemoryAdapterOptions = {}): MemoryAdapter {
  const { latencyMs = 0, chunkSize = 1024 * 1024 } = opts;
  const store = new Map<string, Node>();
  const sessions = new Map<string, Session>();
  const listeners = new Set<(events: ChangeEvent[]) => void>();
  let clock = Date.now();
  let uploadSeq = 0;
  // Strictly increasing, so two writes in the same millisecond differ.
  const tick = (): number => (clock = Math.max(clock + 1, Date.now()));
  const root: Node = { kind: 'directory', mtimeMs: clock };
  const get = (p: string): Node | undefined => (p === '' ? root : store.get(p));

  const emit = (events: ChangeEvent[]): void => {
    if (events.length > 0) for (const l of [...listeners]) l(events);
  };
  const note = (events: ChangeEvent[], type: ChangeEvent['type'], path: string, extra: Partial<ChangeEvent> = {}): void => {
    events.push({ type, path, mtimeMs: get(path)?.mtimeMs, actor: 'user', ...extra });
  };
  const op = async <T>(fn: () => T, signal?: AbortSignal): Promise<T> => {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    if (signal?.aborted) throw cancelled();
    return fn();
  };

  const entryOf = (path: string): Entry => {
    const n = get(path)!;
    const e: Entry = { path, name: basename(path), kind: n.kind, mtimeMs: n.mtimeMs };
    if (n.data) e.size = n.data.length;
    return e;
  };
  const target = (p: string): string => {
    const path = normalizePath(p);
    if (path === '') throw new FsError('invalid', 'path is the root', { path: p });
    return path;
  };
  const existing = (p: string): string => {
    const path = target(p);
    if (!store.has(path)) throw new FsError('not_found', `not found: ${path}`, { path });
    return path;
  };
  /** mkdir -p; walking top-down means a file in the way is hit before anything is created. */
  const ensureDirs = (dir: string, events: ChangeEvent[]): void => {
    let cur = '';
    for (const seg of dir === '' ? [] : dir.split('/')) {
      cur = cur === '' ? seg : `${cur}/${seg}`;
      const n = store.get(cur);
      if (n?.kind === 'file') throw new FsError('conflict', `not a directory: ${cur}`, { path: cur });
      if (!n) {
        store.set(cur, { kind: 'directory', mtimeMs: tick() });
        note(events, 'created', cur);
      }
    }
  };
  const put = (path: string, data: Bytes, overwrite: boolean, events: ChangeEvent[]): Entry => {
    const cur = store.get(path);
    if (cur?.kind === 'directory') throw new FsError('conflict', `is a directory: ${path}`, { path });
    if (cur && !overwrite) throw new FsError('conflict', `already exists: ${path}`, { path });
    ensureDirs(parentPath(path), events);
    store.set(path, { kind: 'file', data, mtimeMs: tick() });
    note(events, cur ? 'updated' : 'created', path);
    return entryOf(path);
  };
  const removeTree = (path: string): void => {
    for (const k of [...store.keys()]) if (isSameOrDescendant(k, path)) store.delete(k);
  };
  const transfer = (kind: 'move' | 'copy', f: string, t: string, o?: { overwrite?: boolean }): Entry => {
    const from = existing(f);
    const to = target(t);
    if (from === to) return entryOf(to);
    if (isSameOrDescendant(to, from) || isSameOrDescendant(from, to)) {
      throw new FsError('invalid', `cannot ${kind} ${from} to ${to}`, { path: to });
    }
    if (store.has(to) && !o?.overwrite) throw new FsError('conflict', `already exists: ${to}`, { path: to });
    const events: ChangeEvent[] = [];
    ensureDirs(parentPath(to), events);
    removeTree(to);
    const moved = [...store].filter(([k]) => isSameOrDescendant(k, from));
    for (const [k, n] of moved) {
      const dest = remapPrefix(k, from, to);
      if (kind === 'move') {
        store.delete(k);
        store.set(dest, n);
      } else store.set(dest, { ...n, data: n.data?.slice(), mtimeMs: tick() });
    }
    note(events, kind === 'move' ? 'moved' : 'created', to, kind === 'move' ? { oldPath: from } : {});
    emit(events);
    return entryOf(to);
  };

  const seed = (path: string, data: Bytes): void => {
    ensureDirs(parentPath(path), []);
    store.set(path, { kind: 'file', data, mtimeMs: tick() });
  };
  for (const [p, v] of Object.entries(opts.files ?? {})) {
    seed(target(p), typeof v === 'string' ? enc.encode(v) : new Uint8Array(v));
  }

  const place = (path: string, data: Bytes, overwrite: boolean): Entry => {
    const events: ChangeEvent[] = [];
    const e = put(path, data, overwrite, events);
    emit(events);
    return e;
  };
  const session = (id: string): Session => {
    const s = sessions.get(id);
    if (!s) throw new FsError('not_found', `unknown upload ${id}`);
    return s;
  };

  const read = ((p: string, as: 'text' | 'blob' | 'arrayBuffer', o?: { signal?: AbortSignal }) =>
    op(() => {
      const path = existing(p);
      const n = store.get(path)!;
      if (!n.data) throw new FsError('invalid', `is a directory: ${path}`, { path });
      return as === 'text' ? dec.decode(n.data) : as === 'blob' ? new Blob([n.data.slice()]) : n.data.slice().buffer;
    }, o?.signal)) as FileSystemAdapter['read'];

  return {
    emit,
    read,
    // ponytail: list/search scan the whole map; add a parent index if a benchmark needs it.
    list: (p, o) =>
      op(() => {
        const dir = normalizePath(p);
        const n = get(dir);
        if (!n) throw new FsError('not_found', `not found: ${dir}`, { path: dir });
        if (n.kind !== 'directory') throw new FsError('invalid', `not a directory: ${dir}`, { path: dir });
        const base = depthOf(dir);
        return [...store.keys()]
          .filter((k) => k !== dir && isSameOrDescendant(k, dir) && depthOf(k) - base <= o.depth)
          .map(entryOf)
          .sort(byPath);
      }, o.signal),
    stat: (p, o) => op(() => (get(normalizePath(p)) ? entryOf(normalizePath(p)) : null), o?.signal),
    search: (q, o) =>
      op(() => {
        const needle = q.normalize('NFC').toLowerCase();
        if (!needle) return [];
        return [...store.keys()].filter((k) => basename(k).toLowerCase().includes(needle)).map(entryOf).sort(byPath);
      }, o?.signal),
    create: (p, kind) =>
      op(() => {
        const path = target(p);
        if (store.has(path)) throw new FsError('conflict', `already exists: ${path}`, { path });
        const events: ChangeEvent[] = [];
        if (kind === 'file') return place(path, new Uint8Array(0), false);
        ensureDirs(path, events);
        emit(events);
        return entryOf(path);
      }),
    write: (p, text, o) =>
      op(() => {
        const path = target(p);
        const cur = store.get(path);
        if (o?.expectedMtimeMs !== undefined && cur?.mtimeMs !== o.expectedMtimeMs) {
          throw new FsError('conflict', `modified since read: ${path}`, { path });
        }
        return place(path, enc.encode(text), true);
      }),
    move: (f, t, o) => op(() => transfer('move', f, t, o)),
    copy: (f, t, o) => op(() => transfer('copy', f, t, o)),
    delete: (p) =>
      op(() => {
        const path = existing(p);
        removeTree(path);
        const events: ChangeEvent[] = [];
        note(events, 'deleted', path);
        emit(events);
      }),
    upload: {
      direct: async (p, file, o) => {
        const data = new Uint8Array(await file.arrayBuffer());
        const entry = await op(() => place(target(p), data, o.overwrite === true), o.signal);
        o.onProgress?.(data.length);
        return entry;
      },
      chunked: {
        init: (p, totalBytes, o) =>
          op(() => {
            const path = target(p);
            if (!Number.isInteger(totalBytes) || totalBytes < 0) throw new FsError('invalid', 'bad totalBytes');
            if (store.has(path) && !o?.overwrite) throw new FsError('conflict', `already exists: ${path}`, { path });
            const uploadId = `u${++uploadSeq}`;
            sessions.set(uploadId, { path, total: totalBytes, overwrite: o?.overwrite === true, buf: new Uint8Array(totalBytes), parts: new Map() });
            return { uploadId, chunkSize };
          }),
        put: async (id, index, offset, data, signal) => {
          const bytes = new Uint8Array(await data.arrayBuffer());
          await op(() => {
            const s = session(id);
            if (offset < 0 || offset + bytes.length > s.total) throw new FsError('invalid', 'chunk out of range');
            s.buf.set(bytes, offset);
            s.parts.set(index, bytes.length);
          }, signal);
        },
        complete: (id) =>
          op(() => {
            const s = session(id);
            if ([...s.parts.values()].reduce((a, b) => a + b, 0) !== s.total) {
              throw new FsError('invalid', 'upload incomplete', { path: s.path });
            }
            const e = place(s.path, s.buf, s.overwrite);
            sessions.delete(id);
            return e;
          }),
        abort: (id) => op(() => void sessions.delete(id)),
      },
    },
    // ponytail: single file only; zipping folders/multiple files needs a zip writer (server has fflate).
    download: (paths) =>
      op(() => {
        const [only, ...rest] = paths.map(existing);
        const n = only === undefined ? undefined : store.get(only);
        if (!n?.data || rest.length > 0) throw new FsError('invalid', 'memory adapter downloads a single file');
        return new Blob([n.data.slice()]);
      }),
    watch: (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
  };
}

// mulberry32: tiny seeded PRNG
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic tree of `files` files, at most `depth` directories deep with up to `breadth` subdirectories per level.
 * @internal — test/benchmark helper
 */
export function generateTree(opts: { files: number; depth: number; breadth: number; seed?: number }): Record<string, string> {
  const rand = prng(opts.seed ?? 1);
  const out: Record<string, string> = {};
  for (let i = 0; i < opts.files; i++) {
    const dirs: string[] = [];
    for (let d = 0; d < opts.depth && rand() < 0.75; d++) dirs.push(`d${Math.floor(rand() * opts.breadth)}`);
    out[[...dirs, `f${i}.txt`].join('/')] = `file ${i}`;
  }
  return out;
}

export type TreeShape = 'wide' | '10x100k' | 'chains64';
const EXTS = ['txt', 'md', 'json', 'ts'];

/**
 * @internal — test/benchmark helper
 *
 * Deterministic benchmark tree of exactly `size` files (folders are implied by the paths):
 * `wide` puts them all in one folder, `10x100k` splits them across 10 folders, `chains64` spreads them across
 * the ends of 64-deep folder chains (one chain per 1000 files). `seed` only varies the file extensions.
 */
export function generateShape(shape: TreeShape, size: number, seed = 1): Record<string, string> {
  const rand = prng(seed);
  const chains = Math.max(1, Math.ceil(size / 1000));
  const chainDir = (c: number): string => `c${c}/` + Array.from({ length: 63 }, (_, i) => `l${i}`).join('/');
  const dirs = shape === 'chains64' ? Array.from({ length: chains }, (_, c) => chainDir(c)) : [];
  const out: Record<string, string> = {};
  for (let i = 0; i < size; i++) {
    const dir = shape === 'wide' ? 'wide' : shape === '10x100k' ? `d${i % 10}` : dirs[i % chains]!;
    out[`${dir}/f${i}.${EXTS[Math.floor(rand() * EXTS.length)]}`] = `file ${i}`;
  }
  return out;
}
