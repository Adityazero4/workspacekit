import {
  FsError,
  isSameOrDescendant,
  joinPath,
  normalizePath,
  parentPath,
  basename,
  type CallOptions,
  type Entry,
  type EntryKind,
  type FileSystemAdapter,
  type FsErrorKind,
} from '@workspacekit/core';

type ReadFormat = 'text' | 'blob' | 'arrayBuffer';

const ERROR_KIND_BY_DOM_NAME: Record<string, FsErrorKind> = {
  NotFoundError: 'not_found',
  TypeMismatchError: 'conflict',
  InvalidModificationError: 'conflict',
  NoModificationAllowedError: 'conflict',
  NotAllowedError: 'forbidden',
  SecurityError: 'forbidden',
  QuotaExceededError: 'too_large',
};

const isDomError = (error: unknown, name: string): boolean =>
  error instanceof DOMException && error.name === name;
const isFile = (handle: FileSystemHandle): handle is FileSystemFileHandle => handle.kind === 'file';
const isDirectory = (handle: FileSystemHandle): handle is FileSystemDirectoryHandle =>
  handle.kind === 'directory';

function asFsError(error: unknown, path: string): unknown {
  if (error instanceof FsError) return error;
  if (error instanceof TypeError) {
    return new FsError('invalid', `${error.message}: ${path}`, { path, cause: error });
  }
  const kind = error instanceof DOMException ? ERROR_KIND_BY_DOM_NAME[error.name] : undefined;
  if (kind === undefined) return error;
  return new FsError(kind, `${(error as Error).message}: ${path}`, { path, cause: error });
}

async function reportingFsErrors<Result>(path: string, operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw asFsError(error, path);
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FsError('cancelled');
}

function nonRootPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '') throw new FsError('invalid', 'path is the root', { path });
  return normalized;
}

async function directoryAt(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const segment of path === '' ? [] : path.split('/')) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
}

async function childOf(directory: FileSystemDirectoryHandle, name: string): Promise<FileSystemHandle> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (!isDomError(error, 'TypeMismatchError')) throw error;
  }
  return directory.getDirectoryHandle(name);
}

async function findHandle(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemHandle | undefined> {
  if (path === '') return root;
  try {
    return await childOf(await directoryAt(root, parentPath(path), false), basename(path));
  } catch (error) {
    if (isDomError(error, 'NotFoundError') || isDomError(error, 'TypeMismatchError')) return undefined;
    throw error;
  }
}

async function existingHandle(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemHandle> {
  const handle = await findHandle(root, path);
  if (!handle) throw new FsError('not_found', `not found: ${path}`, { path });
  return handle;
}

async function entryOf(path: string, handle: FileSystemHandle): Promise<Entry> {
  const entry: Entry = { path, name: basename(path), kind: handle.kind };
  if (isFile(handle)) {
    const file = await handle.getFile();
    entry.size = file.size;
    entry.mtimeMs = file.lastModified;
  }
  return entry;
}

async function collectEntries(
  directory: FileSystemDirectoryHandle,
  path: string,
  depth: number,
  signal: AbortSignal | undefined,
  entries: Entry[],
): Promise<void> {
  for await (const [name, handle] of directory.entries()) {
    throwIfCancelled(signal);
    const childPath = joinPath(path, name);
    entries.push(await entryOf(childPath, handle));
    if (isDirectory(handle) && depth > 1) await collectEntries(handle, childPath, depth - 1, signal, entries);
  }
}

async function overwriteFile(handle: FileSystemFileHandle, data: string | Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function copyInto(
  directory: FileSystemDirectoryHandle,
  name: string,
  source: FileSystemHandle,
): Promise<FileSystemHandle> {
  if (isFile(source)) {
    const copy = await directory.getFileHandle(name, { create: true });
    await overwriteFile(copy, await source.getFile());
    return copy;
  }
  const copy = await directory.getDirectoryHandle(name, { create: true });
  for await (const [childName, child] of (source as FileSystemDirectoryHandle).entries()) {
    await copyInto(copy, childName, child);
  }
  return copy;
}

async function removeAt(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parent = await directoryAt(root, parentPath(path), false);
  await parent.removeEntry(basename(path), { recursive: true });
}

async function expectUnchanged(
  root: FileSystemDirectoryHandle,
  path: string,
  expectedMtimeMs: number,
): Promise<void> {
  const current = await findHandle(root, path);
  const currentMtimeMs = current && isFile(current) ? (await current.getFile()).lastModified : undefined;
  if (currentMtimeMs !== expectedMtimeMs) {
    throw new FsError('conflict', `modified since read: ${path}`, { path });
  }
}

async function writeText(
  root: FileSystemDirectoryHandle,
  path: string,
  text: string,
  expectedMtimeMs: number | undefined,
): Promise<Entry> {
  if (expectedMtimeMs !== undefined) await expectUnchanged(root, path, expectedMtimeMs);
  const parent = await directoryAt(root, parentPath(path), true);
  const handle = await parent.getFileHandle(basename(path), { create: true });
  await overwriteFile(handle, text);
  return entryOf(path, handle);
}

async function createEntry(root: FileSystemDirectoryHandle, path: string, kind: EntryKind): Promise<Entry> {
  if (await findHandle(root, path)) throw new FsError('conflict', `already exists: ${path}`, { path });
  const parent = await directoryAt(root, parentPath(path), true);
  const name = basename(path);
  const handle =
    kind === 'file'
      ? await parent.getFileHandle(name, { create: true })
      : await parent.getDirectoryHandle(name, { create: true });
  return entryOf(path, handle);
}

const temporaryNameFor = (name: string): string => `.${name}.moving-${crypto.randomUUID()}`;
const UNLOCK_WAITS_MS = [25, 50, 100, 200, 400] as const;
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function removeOnceUnlocked(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  for (const waitMs of UNLOCK_WAITS_MS) {
    try {
      await directory.removeEntry(name, { recursive: true });
      return;
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) return;
      if (!isDomError(error, 'NoModificationAllowedError')) throw error;
      await wait(waitMs);
    }
  }
  await directory.removeEntry(name, { recursive: true });
}

async function copyOrCleanUp(
  directory: FileSystemDirectoryHandle,
  name: string,
  source: FileSystemHandle,
): Promise<FileSystemHandle> {
  try {
    return await copyInto(directory, name, source);
  } catch (error) {
    await removeOnceUnlocked(directory, name).catch(() => {
      const reported = asFsError(error, name);
      throw new FsError(
        reported instanceof FsError ? reported.kind : 'unknown',
        `could not copy to ${name}, and the partial copy could not be removed; remove it by hand`,
        { path: name, cause: error },
      );
    });
    throw error;
  }
}

async function moveNatively(
  source: FileSystemHandle,
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  const movable = source as FileSystemHandle & {
    move?: (to: FileSystemDirectoryHandle, newName: string) => Promise<void>;
  };
  if (typeof movable.move !== 'function') return false;
  try {
    await movable.move(directory, name);
    return true;
  } catch (error) {
    if (isDomError(error, 'NotSupportedError') || error instanceof TypeError) return false;
    throw error;
  }
}

async function removeSourceAfterCopy(root: FileSystemDirectoryHandle, from: string, to: string) {
  try {
    await removeAt(root, from);
  } catch (error) {
    throw new FsError('unknown', `copied to ${to} but could not remove ${from}; remove it by hand`, {
      path: from,
      cause: error,
    });
  }
}

async function replaceByCopying(
  root: FileSystemDirectoryHandle,
  directory: FileSystemDirectoryHandle,
  source: FileSystemHandle,
  to: string,
  stagedName: string,
): Promise<FileSystemHandle> {
  const staged = await copyOrCleanUp(directory, stagedName, source);
  await removeAt(root, to);
  try {
    const placed = await copyOrCleanUp(directory, basename(to), staged);
    await directory.removeEntry(stagedName, { recursive: true });
    return placed;
  } catch (error) {
    const reported = asFsError(error, to);
    throw new FsError(
      reported instanceof FsError ? reported.kind : 'unknown',
      `could not place the new content at ${to}; it is kept in ${stagedName}`,
      { path: to, cause: error },
    );
  }
}

async function moveEntry(
  root: FileSystemDirectoryHandle,
  from: string,
  to: string,
  overwrite: boolean,
): Promise<Entry> {
  const source = await existingHandle(root, from);
  if (from === to) return entryOf(to, source);
  if (isSameOrDescendant(to, from) || isSameOrDescendant(from, to)) {
    throw new FsError('invalid', `cannot move ${from} to ${to}`, { path: to });
  }
  const existing = await findHandle(root, to);
  const isRename = existing !== undefined && (await source.isSameEntry(existing));
  if (existing && !isRename && !overwrite) {
    throw new FsError('conflict', `already exists: ${to}`, { path: to });
  }
  const directory = await directoryAt(root, parentPath(to), true);
  if ((!existing || isRename) && (await moveNatively(source, directory, basename(to)))) {
    return entryOf(to, await existingHandle(root, to));
  }
  const placed = existing
    ? await replaceByCopying(root, directory, source, to, temporaryNameFor(basename(to)))
    : await copyOrCleanUp(directory, basename(to), source);
  if (!isRename) await removeSourceAfterCopy(root, from, to);
  return entryOf(to, placed);
}

async function readEntry(
  root: FileSystemDirectoryHandle,
  path: string,
  format: ReadFormat,
  signal: AbortSignal | undefined,
): Promise<string | Blob | ArrayBuffer> {
  const handle = await existingHandle(root, path);
  if (!isFile(handle)) throw new FsError('invalid', `is a directory: ${path}`, { path });
  const file = await handle.getFile();
  throwIfCancelled(signal);
  if (format === 'text') return file.text();
  return format === 'blob' ? file : file.arrayBuffer();
}

async function listEntries(
  root: FileSystemDirectoryHandle,
  path: string,
  depth: number,
  signal: AbortSignal | undefined,
): Promise<Entry[]> {
  const handle = await existingHandle(root, path);
  if (!isDirectory(handle)) throw new FsError('invalid', `not a directory: ${path}`, { path });
  const entries: Entry[] = [];
  await collectEntries(handle, path, depth, signal, entries);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A `FileSystemAdapter` over a directory the user granted with the File System Access API, or over the
 * origin-private file system. It lists, reads, writes, creates, deletes, moves and renames, and has no
 * `watch`, so a workspace polls it. Paths that leave the directory, such as `../x`, are refused with a
 * `forbidden` error.
 *
 * A move uses `handle.move()` where the browser has it. Otherwise it copies first, replaces a destination
 * only after a full copy exists beside it, and deletes the source last, so a failure never loses data.
 *
 * Polling sees a changed file only when its `size` or `mtimeMs` changes, and `list` calls `getFile()` for
 * every file it returns, which is slow on very large folders; keep `fetchDepth` small.
 *
 * @example
 * ```ts
 * const root = await window.showDirectoryPicker({ mode: 'readwrite' });
 * const adapter = fileSystemAccessAdapter(root);
 * ```
 */
export function fileSystemAccessAdapter(root: FileSystemDirectoryHandle): FileSystemAdapter {
  const read = async (path: string, format: ReadFormat, options?: CallOptions) => {
    const target = normalizePath(path);
    return reportingFsErrors(target, () => readEntry(root, target, format, options?.signal));
  };
  return {
    read: read as FileSystemAdapter['read'],
    list: async (path, options) => {
      const target = normalizePath(path);
      return reportingFsErrors(target, () => listEntries(root, target, options.depth, options.signal));
    },
    stat: async (path) => {
      const target = normalizePath(path);
      return reportingFsErrors(target, async () => {
        const handle = await findHandle(root, target);
        return handle ? entryOf(target, handle) : null;
      });
    },
    create: async (path, kind) => {
      const target = nonRootPath(path);
      return reportingFsErrors(target, () => createEntry(root, target, kind));
    },
    write: async (path, text, options) => {
      const target = nonRootPath(path);
      return reportingFsErrors(target, () => writeText(root, target, text, options?.expectedMtimeMs));
    },
    move: async (from, to, options) => {
      const source = nonRootPath(from);
      const destination = nonRootPath(to);
      return reportingFsErrors(destination, () =>
        moveEntry(root, source, destination, options?.overwrite === true),
      );
    },
    delete: async (path) => {
      const target = nonRootPath(path);
      return reportingFsErrors(target, async () => {
        await existingHandle(root, target);
        await removeAt(root, target);
      });
    },
  };
}
