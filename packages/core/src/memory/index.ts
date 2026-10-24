import { FsError } from '../errors';
import { basename, isSameOrDescendant, normalizePath, parentPath, remapPrefix } from '../path';
import type { ChangeEvent, Entry, EntryKind, FileSystemAdapter } from '../types';

type Bytes = Uint8Array<ArrayBuffer>;
interface MemoryNode {
  kind: EntryKind;
  data?: Bytes;
  mtimeMs: number;
}
interface ChunkedUploadSession {
  path: string;
  totalBytes: number;
  overwrite: boolean;
  buffer: Bytes;
  chunkSizes: Map<number, number>;
}

/**
 * Options for `createMemoryAdapter`: seed files, artificial latency and the chunk size it reports.
 *
 * @example
 * ```ts
 * const options: MemoryAdapterOptions = { files: { 'README.md': '# Hi' }, latencyMs: 50, actor: 'agent' };
 * ```
 */
export interface MemoryAdapterOptions {
  files?: Record<string, string | Uint8Array>;
  /** Artificial delay applied to every call. */
  latencyMs?: number;
  /** Chunk size reported by `upload.chunked.init`. */
  chunkSize?: number;
  /** The actor of every change made through this adapter's own methods. Default 'user'. */
  actor?: string;
}
/**
 * An in-memory `FileSystemAdapter` that can also `emit` change events, as if made by someone else. A
 * `created`, `updated` or `moved` event without an `entry` gets the adapter's entry at its path, if one
 * exists. `withActor` returns a view of the same files whose own changes carry that actor.
 *
 * @example
 * ```ts
 * adapter.emit([{ type: 'created', path: 'new.txt', actor: 'external' }]);
 * await adapter.withActor('agent').write!('agent.txt', 'hi');
 * ```
 */
export type MemoryAdapter = FileSystemAdapter & {
  emit(events: ChangeEvent[]): void;
  withActor(actor: string): MemoryAdapter;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byPath = (a: Entry, b: Entry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function nonRootPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '') throw new FsError('invalid', 'path is the root', { path });
  return normalized;
}

const DEFAULT_ACTOR = 'user';

class MemoryFiles {
  #actor = DEFAULT_ACTOR;
  readonly #nodes = new Map<string, MemoryNode>();
  readonly #childrenOf = new Map<string, Set<string>>();
  readonly #listeners = new Set<(events: ChangeEvent[]) => void>();
  #clock = Date.now();
  readonly #root: MemoryNode = { kind: 'directory', mtimeMs: this.#clock };

  #strictlyIncreasingNow(): number {
    return (this.#clock = Math.max(this.#clock + 1, Date.now()));
  }

  get(path: string): MemoryNode | undefined {
    return path === '' ? this.#root : this.#nodes.get(path);
  }

  existingPath(path: string): string {
    const normalized = nonRootPath(path);
    if (!this.#nodes.has(normalized)) {
      throw new FsError('not_found', `not found: ${normalized}`, { path: normalized });
    }
    return normalized;
  }

  entryOf(path: string): Entry {
    const node = this.get(path)!;
    const entry: Entry = { path, name: basename(path), kind: node.kind, mtimeMs: node.mtimeMs };
    if (node.data) entry.size = node.data.length;
    return entry;
  }

  actingAs<T>(actor: string, operation: () => T): T {
    const previousActor = this.#actor;
    this.#actor = actor;
    try {
      return operation();
    } finally {
      this.#actor = previousActor;
    }
  }

  emit(events: ChangeEvent[]): void {
    if (events.length > 0) for (const listener of [...this.#listeners]) listener(events);
  }

  subscribe(listener: (events: ChangeEvent[]) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #note(
    events: ChangeEvent[],
    type: ChangeEvent['type'],
    path: string,
    extra: Partial<ChangeEvent> = {},
  ): void {
    events.push(
      this.withEntry({ type, path, mtimeMs: this.get(path)?.mtimeMs, actor: this.#actor, ...extra }),
    );
  }

  withEntry(event: ChangeEvent): ChangeEvent {
    if (event.entry || event.type === 'deleted' || event.type === 'resync') return event;
    let path: string;
    try {
      path = normalizePath(event.path);
    } catch {
      return event;
    }
    return this.#nodes.has(path) ? { ...event, entry: this.entryOf(path) } : event;
  }

  #setNode(path: string, node: MemoryNode): void {
    if (!this.#nodes.has(path)) {
      const parent = parentPath(path);
      let siblings = this.#childrenOf.get(parent);
      if (!siblings) this.#childrenOf.set(parent, (siblings = new Set()));
      siblings.add(path);
    }
    this.#nodes.set(path, node);
  }

  #deleteNode(path: string): void {
    this.#nodes.delete(path);
    this.#childrenOf.get(parentPath(path))?.delete(path);
    this.#childrenOf.delete(path);
  }

  #subtreeOf(path: string): string[] {
    if (!this.#nodes.has(path)) return [];
    const paths = [path];
    for (let next = 0; next < paths.length; next++) {
      for (const child of this.#childrenOf.get(paths[next]!) ?? []) paths.push(child);
    }
    return paths;
  }

  #descendantsWithin(dir: string, depth: number): string[] {
    const paths: string[] = [];
    let level = [dir];
    for (let remaining = depth; remaining > 0 && level.length > 0; remaining--) {
      const nextLevel: string[] = [];
      for (const folder of level) {
        for (const child of this.#childrenOf.get(folder) ?? []) {
          paths.push(child);
          nextLevel.push(child);
        }
      }
      level = nextLevel;
    }
    return paths;
  }

  #makeDirectories(dir: string, events: ChangeEvent[]): void {
    if (this.get(dir)?.kind === 'directory') return;
    let ancestor = '';
    for (const segment of dir === '' ? [] : dir.split('/')) {
      ancestor = ancestor === '' ? segment : `${ancestor}/${segment}`;
      const node = this.#nodes.get(ancestor);
      if (node?.kind === 'file') {
        throw new FsError('conflict', `not a directory: ${ancestor}`, { path: ancestor });
      }
      if (!node) {
        this.#setNode(ancestor, { kind: 'directory', mtimeMs: this.#strictlyIncreasingNow() });
        this.#note(events, 'created', ancestor);
      }
    }
  }

  seed(path: string, data: Bytes): void {
    this.#makeDirectories(parentPath(path), []);
    this.#setNode(path, { kind: 'file', data, mtimeMs: this.#strictlyIncreasingNow() });
  }

  place(path: string, data: Bytes, overwrite: boolean): Entry {
    const existing = this.#nodes.get(path);
    if (existing?.kind === 'directory') throw new FsError('conflict', `is a directory: ${path}`, { path });
    if (existing && !overwrite) throw new FsError('conflict', `already exists: ${path}`, { path });
    const events: ChangeEvent[] = [];
    this.#makeDirectories(parentPath(path), events);
    this.#setNode(path, { kind: 'file', data, mtimeMs: this.#strictlyIncreasingNow() });
    this.#note(events, existing ? 'updated' : 'created', path);
    this.emit(events);
    return this.entryOf(path);
  }

  #removeTree(path: string): void {
    for (const nodePath of this.#subtreeOf(path)) this.#deleteNode(nodePath);
  }

  transfer(kind: 'move' | 'copy', fromPath: string, toPath: string, overwrite: boolean): Entry {
    const from = this.existingPath(fromPath);
    const to = nonRootPath(toPath);
    if (from === to) return this.entryOf(to);
    if (isSameOrDescendant(to, from) || isSameOrDescendant(from, to)) {
      throw new FsError('invalid', `cannot ${kind} ${from} to ${to}`, { path: to });
    }
    if (this.#nodes.has(to) && !overwrite) {
      throw new FsError('conflict', `already exists: ${to}`, { path: to });
    }
    const events: ChangeEvent[] = [];
    this.#makeDirectories(parentPath(to), events);
    this.#removeTree(to);
    const transferred = this.#subtreeOf(from).map(
      (nodePath) => [nodePath, this.#nodes.get(nodePath)!] as const,
    );
    for (const [nodePath, node] of transferred) {
      const destination = remapPrefix(nodePath, from, to);
      if (kind === 'move') {
        this.#deleteNode(nodePath);
        this.#setNode(destination, node);
      } else {
        this.#setNode(destination, {
          ...node,
          data: node.data?.slice(),
          mtimeMs: this.#strictlyIncreasingNow(),
        });
      }
    }
    this.#note(events, kind === 'move' ? 'moved' : 'created', to, kind === 'move' ? { oldPath: from } : {});
    this.emit(events);
    return this.entryOf(to);
  }

  list(path: string, depth: number): Entry[] {
    const dir = normalizePath(path);
    const node = this.get(dir);
    if (!node) throw new FsError('not_found', `not found: ${dir}`, { path: dir });
    if (node.kind !== 'directory') throw new FsError('invalid', `not a directory: ${dir}`, { path: dir });
    return this.#descendantsWithin(dir, depth)
      .sort()
      .map((nodePath) => this.entryOf(nodePath));
  }

  search(query: string): Entry[] {
    const needle = query.normalize('NFC').toLowerCase();
    if (!needle) return [];
    return [...this.#nodes.keys()]
      .filter((nodePath) => basename(nodePath).toLowerCase().includes(needle))
      .map((nodePath) => this.entryOf(nodePath))
      .sort(byPath);
  }

  create(path: string, kind: EntryKind): Entry {
    const target = nonRootPath(path);
    if (this.#nodes.has(target)) throw new FsError('conflict', `already exists: ${target}`, { path: target });
    if (kind === 'file') return this.place(target, new Uint8Array(0), false);
    const events: ChangeEvent[] = [];
    this.#makeDirectories(target, events);
    this.emit(events);
    return this.entryOf(target);
  }

  write(path: string, text: string, expectedMtimeMs: number | undefined): Entry {
    const target = nonRootPath(path);
    if (expectedMtimeMs !== undefined && this.#nodes.get(target)?.mtimeMs !== expectedMtimeMs) {
      throw new FsError('conflict', `modified since read: ${target}`, { path: target });
    }
    return this.place(target, encoder.encode(text), true);
  }

  delete(path: string): void {
    const target = this.existingPath(path);
    this.#removeTree(target);
    const events: ChangeEvent[] = [];
    this.#note(events, 'deleted', target);
    this.emit(events);
  }

  read(path: string, as: 'text' | 'blob' | 'arrayBuffer'): string | Blob | ArrayBuffer {
    const target = this.existingPath(path);
    const { data } = this.#nodes.get(target)!;
    if (!data) throw new FsError('invalid', `is a directory: ${target}`, { path: target });
    if (as === 'text') return decoder.decode(data);
    return as === 'blob' ? new Blob([data.slice()]) : data.slice().buffer;
  }

  downloadSingleFile(paths: string[]): Blob {
    const [only, ...rest] = paths.map((path) => this.existingPath(path));
    const data = only === undefined ? undefined : this.#nodes.get(only)?.data;
    if (!data || rest.length > 0) throw new FsError('invalid', 'memory adapter downloads a single file');
    return new Blob([data.slice()]);
  }

  has(path: string): boolean {
    return this.#nodes.has(path);
  }
}

class MemoryUploads {
  readonly #sessions = new Map<string, ChunkedUploadSession>();
  readonly #files: MemoryFiles;
  readonly #chunkSize: number;
  #lastUploadNumber = 0;

  constructor(files: MemoryFiles, chunkSize: number) {
    this.#files = files;
    this.#chunkSize = chunkSize;
  }

  init(path: string, totalBytes: number, overwrite: boolean): { uploadId: string; chunkSize: number } {
    const target = nonRootPath(path);
    if (!Number.isInteger(totalBytes) || totalBytes < 0) throw new FsError('invalid', 'bad totalBytes');
    if (this.#files.has(target) && !overwrite) {
      throw new FsError('conflict', `already exists: ${target}`, { path: target });
    }
    const uploadId = `u${++this.#lastUploadNumber}`;
    const buffer = new Uint8Array(totalBytes);
    this.#sessions.set(uploadId, { path: target, totalBytes, overwrite, buffer, chunkSizes: new Map() });
    return { uploadId, chunkSize: this.#chunkSize };
  }

  put(uploadId: string, index: number, offset: number, bytes: Bytes): void {
    const session = this.#session(uploadId);
    if (offset < 0 || offset + bytes.length > session.totalBytes) {
      throw new FsError('invalid', 'chunk out of range');
    }
    session.buffer.set(bytes, offset);
    session.chunkSizes.set(index, bytes.length);
  }

  complete(uploadId: string): Entry {
    const session = this.#session(uploadId);
    const received = [...session.chunkSizes.values()].reduce((sum, size) => sum + size, 0);
    if (received !== session.totalBytes) {
      throw new FsError('invalid', 'upload incomplete', { path: session.path });
    }
    const entry = this.#files.place(session.path, session.buffer, session.overwrite);
    this.#sessions.delete(uploadId);
    return entry;
  }

  abort(uploadId: string): void {
    this.#sessions.delete(uploadId);
  }

  #session(uploadId: string): ChunkedUploadSession {
    const session = this.#sessions.get(uploadId);
    if (!session) throw new FsError('not_found', `unknown upload ${uploadId}`);
    return session;
  }
}

/**
 * A complete `FileSystemAdapter` kept in memory, for tests, demos and prototypes. Every call waits
 * `latencyMs`, mtimes strictly increase, and every change is delivered to `watch` listeners. Downloads
 * support a single file only.
 *
 * @example
 * ```ts
 * const adapter = createMemoryAdapter({ files: { 'src/main.ts': 'export {};', 'README.md': '# Demo' } });
 * const entries = await adapter.list('', { depth: 2 });
 * ```
 */
export function createMemoryAdapter(opts: MemoryAdapterOptions = {}): MemoryAdapter {
  const { latencyMs = 0, chunkSize = 1024 * 1024 } = opts;
  const files = new MemoryFiles();
  const uploads = new MemoryUploads(files, chunkSize);
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    files.seed(
      nonRootPath(path),
      typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content),
    );
  }
  return adapterOver(files, uploads, latencyMs, opts.actor ?? DEFAULT_ACTOR);
}

function adapterOver(
  files: MemoryFiles,
  uploads: MemoryUploads,
  latencyMs: number,
  actor: string,
): MemoryAdapter {
  const afterLatency = async <T>(operation: () => T, signal?: AbortSignal): Promise<T> => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (signal?.aborted) throw new FsError('cancelled');
    return files.actingAs(actor, operation);
  };
  const read = (path: string, as: 'text' | 'blob' | 'arrayBuffer', options?: { signal?: AbortSignal }) =>
    afterLatency(() => files.read(path, as), options?.signal);
  return {
    withActor: (otherActor) => adapterOver(files, uploads, latencyMs, otherActor),
    emit: (events) => files.emit(events.map((event) => files.withEntry(event))),
    read: read as FileSystemAdapter['read'],
    list: (path, options) => afterLatency(() => files.list(path, options.depth), options.signal),
    stat: (path, options) =>
      afterLatency(() => {
        const normalized = normalizePath(path);
        return files.get(normalized) ? files.entryOf(normalized) : null;
      }, options?.signal),
    search: (query, options) => afterLatency(() => files.search(query), options?.signal),
    create: (path, kind) => afterLatency(() => files.create(path, kind)),
    write: (path, text, options) => afterLatency(() => files.write(path, text, options?.expectedMtimeMs)),
    move: (from, to, options) =>
      afterLatency(() => files.transfer('move', from, to, options?.overwrite === true)),
    copy: (from, to, options) =>
      afterLatency(() => files.transfer('copy', from, to, options?.overwrite === true)),
    delete: (path) => afterLatency(() => files.delete(path)),
    upload: {
      direct: async (path, file, options) => {
        const data = new Uint8Array(await file.arrayBuffer());
        const entry = await afterLatency(
          () => files.place(nonRootPath(path), data, options.overwrite === true),
          options.signal,
        );
        options.onProgress?.(data.length);
        return entry;
      },
      chunked: {
        init: (path, totalBytes, options) =>
          afterLatency(() => uploads.init(path, totalBytes, options?.overwrite === true)),
        put: async (uploadId, index, offset, data, signal) => {
          const bytes = new Uint8Array(await data.arrayBuffer());
          await afterLatency(() => uploads.put(uploadId, index, offset, bytes), signal);
        },
        complete: (uploadId) => afterLatency(() => uploads.complete(uploadId)),
        abort: (uploadId) => afterLatency(() => uploads.abort(uploadId)),
      },
    },
    download: (paths) => afterLatency(() => files.downloadSingleFile(paths)),
    watch: (onChange) => files.subscribe(onChange),
  };
}
