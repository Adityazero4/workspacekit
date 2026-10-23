import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { FsError, isSameOrDescendant, normalizePath, type Entry, type TransferOptions } from '@scope/core';
import { isInside, resolveInRoot, resolvesInside, toStoreError } from './jail';
import type { FileStore } from './store';
import { createWatcher, type Probe, type Subscribe } from './watch';

const STAGING_FILE_NAME = /^\..+\.[0-9a-f]{12}\.tmp$/;
const stagingPathNextTo = (abs: string): string =>
  path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
const foldForExclusion = (name: string): string => name.normalize('NFC').toLowerCase();
const ignoreError = (): void => undefined;
const notFound = (rel: string): FsError => new FsError('not_found', `ENOENT: ${rel}`, { path: rel });
const escapesRoot = (rel: string): FsError => new FsError('forbidden', 'path escapes root', { path: rel });

async function nullIfMissing<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

const unusableRootError = (): FsError =>
  new FsError(
    'unknown',
    'nodeFsStore has no root directory: set the environment variable that holds it (for example AGENT_WORKSPACE_DIR) before the first request',
  );

function assertNotRoot(rel: string): void {
  if (rel === '') throw new FsError('invalid', 'operation not allowed on the root', { path: rel });
}

function entryFromStats(rel: string, stats: Stats): Entry {
  const isDirectory = stats.isDirectory();
  return {
    path: rel,
    name: path.basename(rel),
    kind: isDirectory ? 'directory' : 'file',
    size: isDirectory ? null : stats.size,
    mtimeMs: Math.floor(stats.mtimeMs),
  };
}

const isSameInode = (a: Stats, b: Stats): boolean => a.ino === b.ino && a.dev === b.dev;

async function assertLinkStaysInside(
  rootReal: string,
  link: string,
  destination: string,
  rel: string,
): Promise<void> {
  const target = await readlink(link);
  const segments = target.split('/');
  const climbsOutOfANamedSegment = segments.some(
    (segment, at) =>
      segment === '..' && segments.slice(0, at).some((before) => before !== '' && before !== '..'),
  );
  if (
    climbsOutOfANamedSegment ||
    !(await resolvesInside(rootReal, path.resolve(path.dirname(destination), target)))
  ) {
    throw new FsError('forbidden', `link would leave the root: ${rel}`, { path: rel });
  }
}

interface WriteOptions {
  expectedMtimeMs?: number;
  overwrite?: boolean;
  maxBytes?: number;
}

async function replacementTarget(abs: string, rel: string, options: WriteOptions): Promise<string> {
  const existing = await nullIfMissing(stat(abs));
  if (existing?.isDirectory()) throw new FsError('conflict', `EISDIR: ${rel}`, { path: rel });
  if (existing && options.overwrite === false) throw new FsError('conflict', `EEXIST: ${rel}`, { path: rel });
  const mtimeMismatch =
    options.expectedMtimeMs !== undefined &&
    (!existing || Math.floor(existing.mtimeMs) !== options.expectedMtimeMs);
  if (mtimeMismatch) throw new FsError('conflict', `file changed: ${rel}`, { path: rel });
  return existing ? realpath(abs) : abs;
}

async function writeAll(
  handle: FileHandle,
  data: ReadableStream<Uint8Array> | Uint8Array,
  maxBytes: number | undefined,
  rel: string,
): Promise<void> {
  const tooLarge = (): FsError =>
    new FsError('too_large', `exceeds ${maxBytes} bytes: ${rel}`, { path: rel });
  if (data instanceof Uint8Array) {
    try {
      if (maxBytes !== undefined && data.byteLength > maxBytes) throw tooLarge();
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return;
  }
  let written = 0;
  await pipeline(
    Readable.fromWeb(data as unknown as NodeWebStream<Uint8Array>),
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        written += chunk.byteLength;
        if (maxBytes !== undefined && written > maxBytes) throw tooLarge();
        yield chunk;
      }
    },
    handle.createWriteStream(),
  );
}

function satisfiableRange(
  range: { start: number; end: number },
  size: number,
  rel: string,
): { start: number; end: number } {
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    throw new FsError('invalid', `unsatisfiable range: ${rel}`, { path: rel });
  }
  return { start, end: Math.min(end, size - 1) };
}

class SerialLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task);
    this.#tail = run.catch(ignoreError);
    return run;
  }
}

interface QueuedDirectory {
  rel: string;
  abs: string;
  yieldedEntry?: Entry;
}

interface WalkedChild {
  entry: Entry;
  realDirectory: string | undefined;
}

interface StagedWrite {
  dir: string;
  stagingPath: string;
  handle: FileHandle;
}

class NodeFsStore implements FileStore {
  readonly #root: string;
  readonly #excluded: Set<string>;
  readonly #searchLimit: number;
  readonly #lock = new SerialLock();
  readonly #unusableRoot: FsError | undefined;
  #rootRealPending: Promise<string> | undefined;
  readonly watch: Subscribe;

  constructor(root: string, options: { exclude?: string[]; searchLimit?: number }) {
    this.#root = root;
    const unusableRoot = typeof root === 'string' && root.trim() !== '' ? undefined : unusableRootError();
    this.#excluded = new Set((options.exclude ?? []).map(foldForExclusion));
    this.#searchLimit = options.searchLimit ?? 200;
    this.#unusableRoot = unusableRoot;
    this.watch = unusableRoot
      ? () => {
          throw unusableRoot;
        }
      : createWatcher({
          root: path.resolve(root),
          hiddenName: (name) => this.#isHidden(name),
          probe: (rel, osReportedName) => this.#probe(rel, osReportedName),
        });
  }

  list = (requestedPath: string, depth: number): Promise<Entry[]> =>
    this.#run(requestedPath, async (rel, rootReal) => {
      const abs = await this.#lock.run(() => this.#realDirectory(rootReal, rel));
      const entries: Entry[] = [];
      for await (const entry of this.#walk(rootReal, rel, abs, Math.floor(depth))) entries.push(entry);
      return entries;
    });

  stat = (requestedPath: string): Promise<Entry | null> =>
    this.#run(requestedPath, (rel, rootReal) =>
      this.#lock.run(async () => this.#entryAt(rootReal, await this.#resolve(rootReal, rel), rel)),
    ).catch((error: unknown) => {
      if (error instanceof FsError && error.kind === 'not_found') return null;
      throw error;
    });

  read = (
    requestedPath: string,
    range?: { start: number; end: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; entry: Entry }> =>
    this.#run(requestedPath, async (rel, rootReal) => {
      const opened = await this.#lock.run(() => this.#openForRead(rootReal, rel, range));
      const fileStream = opened.handle.createReadStream({ start: opened.start, end: opened.end });
      const body = Readable.toWeb(fileStream) as unknown as ReadableStream<Uint8Array>;
      return { body, size: opened.size, entry: opened.entry };
    });

  write = (
    requestedPath: string,
    data: ReadableStream<Uint8Array> | Uint8Array,
    options: WriteOptions = {},
  ): Promise<Entry> =>
    this.#run(requestedPath, (rel, rootReal) => this.#writeFile(rootReal, rel, data, options));

  create = (requestedPath: string, kind: Entry['kind']): Promise<Entry> =>
    this.#run(
      requestedPath,
      async (rel, rootReal) => {
        assertNotRoot(rel);
        const abs = await this.#resolve(rootReal, rel, true);
        if (await nullIfMissing(lstat(abs))) throw new FsError('conflict', `EEXIST: ${rel}`, { path: rel });
        await mkdir(path.dirname(abs), { recursive: true });
        if (kind === 'directory') await mkdir(abs);
        else await writeFile(abs, '', { flag: 'wx' });
        return this.#createdEntry(rootReal, abs, rel);
      },
      true,
    );

  move = (from: string, to: string, options?: TransferOptions): Promise<Entry> =>
    this.#transfer('move', from, to, options);

  copy = (from: string, to: string, options?: TransferOptions): Promise<Entry> =>
    this.#transfer('copy', from, to, options);

  delete = (requestedPath: string): Promise<void> =>
    this.#run(
      requestedPath,
      async (rel, rootReal) => {
        assertNotRoot(rel);
        await rm(await this.#resolve(rootReal, rel), { recursive: true });
      },
      true,
    );

  search = (query: string, limit: number): Promise<Entry[]> =>
    this.#run('', async (rel, rootReal) => {
      const needle = query.normalize('NFC').toLowerCase();
      const max = Math.min(limit, this.#searchLimit);
      const found: Entry[] = [];
      if (!needle || max < 1) return found;
      for await (const entry of this.#walk(rootReal, rel, rootReal, Infinity)) {
        if (!entry.name.toLowerCase().includes(needle)) continue;
        found.push(entry);
        if (found.length >= max) break;
      }
      return found;
    });

  #isExcluded(name: string): boolean {
    return this.#excluded.has(foldForExclusion(name));
  }

  #isHidden(name: string): boolean {
    return this.#isExcluded(name) || STAGING_FILE_NAME.test(name);
  }

  #underExcluded(rootReal: string, abs: string): boolean {
    return path
      .relative(rootReal, abs)
      .split(path.sep)
      .some((name) => this.#isExcluded(name));
  }

  #assertVisible(rel: string): void {
    if (rel.split('/').some((name) => this.#isExcluded(name))) throw notFound(rel);
  }

  #rootReal(): Promise<string> {
    if (this.#unusableRoot) return Promise.reject(this.#unusableRoot);
    return (this.#rootRealPending ??= realpath(this.#root).catch(() => {
      this.#rootRealPending = undefined;
      throw new FsError('unknown', 'server root is unavailable');
    }));
  }

  async #run<T>(
    requestedPath: string,
    operation: (rel: string, rootReal: string) => Promise<T>,
    exclusive = false,
  ): Promise<T> {
    const rel = normalizePath(requestedPath);
    this.#assertVisible(rel);
    try {
      const rootReal = await this.#rootReal();
      return await (exclusive ? this.#lock.run(() => operation(rel, rootReal)) : operation(rel, rootReal));
    } catch (error) {
      throw toStoreError(error, rel);
    }
  }

  async #resolve(rootReal: string, rel: string, forCreate = false): Promise<string> {
    const abs = await resolveInRoot(rootReal, rel, { forCreate });
    const real = await realpath(abs).catch(() => abs);
    if (this.#underExcluded(rootReal, abs) || this.#underExcluded(rootReal, real)) throw notFound(rel);
    return abs;
  }

  async #entryAt(rootReal: string, abs: string, rel: string): Promise<Entry | null> {
    let stats = await nullIfMissing(lstat(abs));
    if (stats?.isSymbolicLink()) {
      try {
        const real = await realpath(abs);
        if (!isInside(rootReal, real) || this.#underExcluded(rootReal, real)) return null;
        stats = await stat(real);
      } catch {
        return null;
      }
    }
    if (!stats || !(stats.isFile() || stats.isDirectory())) return null;
    return entryFromStats(rel, stats);
  }

  async #createdEntry(rootReal: string, abs: string, rel: string): Promise<Entry> {
    const linkStats = await lstat(abs);
    if (!linkStats.isSymbolicLink()) return entryFromStats(rel, linkStats);
    const real = await realpath(abs).catch(() => null);
    const targetStats = real !== null && isInside(rootReal, real) ? await stat(real).catch(() => null) : null;
    return entryFromStats(rel, targetStats ?? linkStats);
  }

  async #realDirectory(rootReal: string, rel: string): Promise<string> {
    const real = await realpath(await this.#resolve(rootReal, rel));
    if (!(await stat(real)).isDirectory()) {
      throw new FsError('invalid', `not a directory: ${rel}`, { path: rel });
    }
    return real;
  }

  async *#walk(rootReal: string, startRel: string, startAbs: string, depth: number): AsyncGenerator<Entry> {
    let level: QueuedDirectory[] = [{ rel: startRel, abs: startAbs }];
    for (let levelDepth = 0; levelDepth < depth && level.length > 0; levelDepth++) {
      const nextLevel: QueuedDirectory[] = [];
      for (const directory of level) {
        const children = await this.#lock.run(() =>
          this.#readQueuedDirectory(rootReal, directory, levelDepth === 0),
        );
        if (!children && directory.yieldedEntry) directory.yieldedEntry.meta = { incomplete: true };
        for (const child of children ?? []) {
          const isLinkToDirectory = !child.realDirectory && child.entry.kind === 'directory';
          if (isLinkToDirectory && levelDepth + 1 < depth) child.entry.meta = { incomplete: true };
          yield child.entry;
          if (child.realDirectory) {
            nextLevel.push({ rel: child.entry.path, abs: child.realDirectory, yieldedEntry: child.entry });
          }
        }
      }
      level = nextLevel;
    }
  }

  async #readQueuedDirectory(
    rootReal: string,
    directory: QueuedDirectory,
    isWalkStart: boolean,
  ): Promise<WalkedChild[] | null> {
    const real = await realpath(directory.abs).catch(() => null);
    const stillTheQueuedDirectory = real === directory.abs && isInside(rootReal, real);
    if (!stillTheQueuedDirectory) {
      if (isWalkStart) throw notFound(directory.rel);
      return null;
    }
    const items = await readdir(directory.abs, { withFileTypes: true }).catch((error: unknown) => {
      if (isWalkStart) throw error;
      return null;
    });
    if (!items) return null;
    const children: WalkedChild[] = [];
    for (const item of items) {
      const name = item.name.normalize('NFC');
      if (this.#isHidden(name)) continue;
      const childRel = directory.rel ? `${directory.rel}/${name}` : name;
      const childAbs = path.join(directory.abs, item.name);
      const entry = await this.#entryAt(rootReal, childAbs, childRel);
      if (entry) children.push({ entry, realDirectory: item.isDirectory() ? childAbs : undefined });
    }
    return children;
  }

  async #openForRead(
    rootReal: string,
    rel: string,
    range: { start: number; end: number } | undefined,
  ): Promise<{ entry: Entry; start?: number; end?: number; size: number; handle: FileHandle }> {
    const abs = await this.#resolve(rootReal, rel);
    const stats = await stat(abs);
    if (stats.isDirectory()) throw new FsError('invalid', `is a directory: ${rel}`, { path: rel });
    const entry = await this.#entryAt(rootReal, abs, rel);
    if (!entry) throw notFound(rel);
    const bounds = range ? satisfiableRange(range, stats.size, rel) : undefined;
    const size = bounds ? bounds.end - bounds.start + 1 : stats.size;
    return { entry, start: bounds?.start, end: bounds?.end, size, handle: await open(abs, 'r') };
  }

  async #writeFile(
    rootReal: string,
    rel: string,
    data: ReadableStream<Uint8Array> | Uint8Array,
    options: WriteOptions,
  ): Promise<Entry> {
    assertNotRoot(rel);
    const staged = await this.#lock.run(() => this.#openStagingFile(rootReal, rel, options));
    try {
      await writeAll(staged.handle, data, options.maxBytes, rel);
      return await this.#lock.run(() => this.#commitStagedWrite(rootReal, rel, staged, options));
    } catch (error) {
      await rm(staged.stagingPath, { force: true }).catch(ignoreError);
      throw error;
    }
  }

  async #openStagingFile(rootReal: string, rel: string, options: WriteOptions): Promise<StagedWrite> {
    const abs = await this.#resolve(rootReal, rel, true);
    await replacementTarget(abs, rel, options);
    await mkdir(path.dirname(abs), { recursive: true });
    const dir = await realpath(path.dirname(abs));
    if (!isInside(rootReal, dir)) throw escapesRoot(rel);
    const stagingPath = stagingPathNextTo(path.join(dir, path.basename(abs)));
    return { dir, stagingPath, handle: await open(stagingPath, 'wx') };
  }

  async #commitStagedWrite(
    rootReal: string,
    rel: string,
    staged: StagedWrite,
    options: WriteOptions,
  ): Promise<Entry> {
    const abs = await this.#resolve(rootReal, rel, true);
    const targetDir = await realpath(path.dirname(abs));
    const stagingDir = await realpath(path.dirname(staged.stagingPath));
    if (!isInside(rootReal, targetDir) || !isInside(rootReal, stagingDir)) throw escapesRoot(rel);
    if (targetDir !== staged.dir || stagingDir !== staged.dir) {
      throw new FsError('conflict', `directory changed during write: ${rel}`, { path: rel });
    }
    const destination = await replacementTarget(abs, rel, options);
    if (!isInside(rootReal, destination)) throw escapesRoot(rel);
    if (this.#underExcluded(rootReal, destination)) throw notFound(rel);
    await rename(staged.stagingPath, destination);
    return this.#createdEntry(rootReal, abs, rel);
  }

  async #transfer(
    kind: 'move' | 'copy',
    from: string,
    to: string,
    options: TransferOptions = {},
  ): Promise<Entry> {
    const target = normalizePath(to);
    this.#assertVisible(target);
    return this.#run(
      from,
      (source, rootReal) => this.#transferLocked(kind, rootReal, source, target, options),
      true,
    );
  }

  async #transferLocked(
    kind: 'move' | 'copy',
    rootReal: string,
    source: string,
    target: string,
    options: TransferOptions,
  ): Promise<Entry> {
    assertNotRoot(source);
    assertNotRoot(target);
    const sourceAbs = await this.#resolve(rootReal, source);
    if (source === target) return this.#createdEntry(rootReal, sourceAbs, source);
    if (isSameOrDescendant(target, source) || isSameOrDescendant(source, target)) {
      throw new FsError('invalid', `cannot ${kind} a folder into itself`, { path: source });
    }
    const targetAbs = await this.#resolve(rootReal, target, true);
    const sourceStats = await lstat(sourceAbs);
    if (sourceStats.isSymbolicLink()) await assertLinkStaysInside(rootReal, sourceAbs, targetAbs, source);
    const targetStats = await nullIfMissing(lstat(targetAbs));
    const sameFile = targetStats !== null && isSameInode(targetStats, sourceStats);
    if (targetStats && !sameFile && !options.overwrite) {
      throw new FsError('conflict', `EEXIST: ${target}`, { path: target });
    }
    await mkdir(path.dirname(targetAbs), { recursive: true });
    if (sameFile) {
      if (kind === 'move') await rename(sourceAbs, targetAbs);
      return this.#createdEntry(rootReal, targetAbs, target);
    }
    const staged =
      kind === 'copy'
        ? await this.#copyToStaging(sourceAbs, targetAbs, targetStats !== null, options)
        : sourceAbs;
    if (kind === 'move' || staged !== targetAbs) {
      const renameCannotReplace =
        targetStats !== null && (sourceStats.isDirectory() || targetStats.isDirectory());
      await replaceWith(staged, targetAbs, renameCannotReplace, kind === 'copy');
    }
    return this.#createdEntry(rootReal, targetAbs, target);
  }

  async #copyToStaging(
    sourceAbs: string,
    targetAbs: string,
    targetExists: boolean,
    options: TransferOptions,
  ): Promise<string> {
    const staged = targetExists ? stagingPathNextTo(targetAbs) : targetAbs;
    try {
      await cp(sourceAbs, staged, {
        recursive: true,
        errorOnExist: !options.overwrite,
        force: !!options.overwrite,
        verbatimSymlinks: true,
        filter: (copied) => !this.#isHidden(path.basename(copied)),
      });
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(ignoreError);
      throw error;
    }
    return staged;
  }

  async #probe(rel: string, osReportedName: string): Promise<Probe> {
    const rootReal = await this.#rootReal();
    const abs = path.join(rootReal, osReportedName);
    const dir = await nullIfMissing(realpath(path.dirname(abs)));
    if (dir === null) return null;
    if (!isInside(rootReal, dir) || this.#underExcluded(rootReal, dir)) return undefined;
    const linkStats = await nullIfMissing(lstat(abs));
    if (!linkStats) return null;
    const entry = await this.#entryAt(rootReal, abs, rel);
    return entry ? { birthMs: linkStats.birthtimeMs, entry } : undefined;
  }
}

async function replaceWith(
  staged: string,
  targetAbs: string,
  removeTargetFirst: boolean,
  removeStagedOnFailure: boolean,
): Promise<void> {
  try {
    if (removeTargetFirst) await rm(targetAbs, { recursive: true, force: true });
    await rename(staged, targetAbs);
  } catch (error) {
    if (removeStagedOnFailure) await rm(staged, { recursive: true, force: true }).catch(ignoreError);
    throw error;
  }
}

/**
 * A `FileStore` over a directory tree. Every symlink on a path is resolved and must stay inside
 * the root; mutations and the open step of `read`, `stat`, and each directory step of `list`/`search`
 * run one at a time under a per-store lock, each re-resolving its path immediately before acting.
 * Writes are staged in a temporary file next to the target and renamed into place, so a failed write
 * loses nothing; a copy over an existing destination is staged the same way.
 *
 * Listings walk breadth-first. Each directory is read in its own locked section, after checking that it is
 * still the real directory it was queued as, so a concurrent move cannot swap a queued directory for a link
 * that leaves the root, and big walks do not starve mutations. A directory that should be walked but is not
 * (a link to a directory, unreadable, or swapped since it was queued) gets `meta: { incomplete: true }`, so
 * clients do not take it as empty.
 *
 * The root is only checked when the first operation runs, so a route module that creates the store at import
 * time (for example while `next build` collects page data) does not crash without its environment variable.
 * An undefined or empty root, or a directory that is missing, rejects each operation with an `FsError`
 * (`'unknown'`, so the handler answers a generic 500 and reports the detail to `onError`); `watch` throws
 * the same error.
 *
 * Residual risk: a local process racing the server outside the HTTP API can still redirect a
 * single fs call (TOCTOU between the check and the syscall); acceptable for v1.
 *
 * @example
 * const store = nodeFsStore('/srv/workspace', { exclude: ['.git', 'node_modules'] });
 * const entries = await store.list('', 2);
 */
export function nodeFsStore(
  root: string,
  opts: { exclude?: string[]; searchLimit?: number } = {},
): FileStore {
  return new NodeFsStore(root, opts);
}
