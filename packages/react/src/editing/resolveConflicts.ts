import {
  basename,
  FsError,
  joinPath,
  parentPath,
  toFsError,
  uniqueName,
  type Entry,
  type FileSystemAdapter,
} from '@workspacekit/core';
import { entryOnTheServer } from '../actions/serverEntry';
import type { EditBuffer, EditBufferHost } from './editBuffer';

/**
 * Where Save mine as a copy put the text, and the version of the original that replaces the edits there.
 *
 * @example
 * ```ts
 * const saved: SavedCopy | undefined = await editBuffers.saveCopy('notes.md');
 * ```
 */
export interface SavedCopy {
  copyPath: string;
  theirVersion: number | undefined;
  /** The text changed while the copy was written, so the edits were kept (still in conflict). */
  editsKept: boolean;
}

function markDeleted(host: EditBufferHost, buffer: EditBuffer): void {
  buffer.remote = 'deleted';
  buffer.stillOnTheServer = false;
  host.refresh(buffer);
}

/**
 * Keep mine: reads the server's version of the buffer's file, then saves the edited text over exactly that
 * version (`expectedMtimeMs`), so a change made in between is a conflict again, never overwritten. A file
 * that is gone goes to `deleted` (Save creates it again); a server copy without `mtimeMs` cannot be
 * confirmed and is refused.
 *
 * @example
 * ```ts
 * await keepMine(host, 'notes.md');
 * ```
 */
export async function keepMine(host: EditBufferHost, path: string): Promise<void> {
  const buffer = host.find(path);
  if (!buffer) return;
  await host.settled(buffer);
  const target = buffer.path;
  const onTheServer = await entryOnTheServer(host.session.adapter, target);
  if (host.find(target) !== buffer) return;
  if (!onTheServer) {
    markDeleted(host, buffer);
    return;
  }
  if (onTheServer.mtimeMs === undefined) {
    throw new FsError(
      'invalid',
      `can't confirm the server copy of "${basename(target)}"; choose Save mine as a copy`,
      {
        path: target,
      },
    );
  }
  buffer.knownVersions.add(onTheServer.mtimeMs);
  buffer.seenWhileSaving.clear();
  buffer.remote = undefined;
  buffer.stillOnTheServer = true;
  buffer.autosaver.rebase(onTheServer.mtimeMs);
  host.refresh(buffer);
  await buffer.autosaver.flush();
}

/**
 * Take theirs: drops the buffer and records the server's entry in the store, so the viewer loads their
 * version. Resolves with that version's `mtimeMs` (`undefined` when the server could not be read).
 *
 * @example
 * ```ts
 * const theirVersion = await takeTheirs(host, 'notes.md');
 * ```
 */
export async function takeTheirs(host: EditBufferHost, path: string): Promise<number | undefined> {
  const buffer = host.find(path);
  if (!buffer) return undefined;
  buffer.retired = true;
  await host.settled(buffer);
  const target = buffer.path;
  const onTheServer = await entryOnTheServer(host.session.adapter, target).catch(() => null);
  host.drop(buffer);
  if (onTheServer) host.session.store.applyChanges([{ type: 'updated', path: target, entry: onTheServer }]);
  return onTheServer?.mtimeMs;
}

async function removeEmptyCopy(
  adapter: FileSystemAdapter,
  copyPath: string,
  failure: unknown,
): Promise<never> {
  const error = toFsError(failure);
  const removed = adapter.delete
    ? await adapter.delete(copyPath).then(
        () => true,
        () => false,
      )
    : false;
  if (removed) throw error;
  throw new FsError(error.kind, `${error.message}; an empty "${basename(copyPath)}" was left behind`, {
    path: copyPath,
    cause: error,
  });
}

async function writeNewCopy(
  adapter: FileSystemAdapter,
  folder: string,
  name: string,
  text: string,
): Promise<Entry> {
  if (!adapter.create || !adapter.write) {
    throw new FsError('invalid', 'This adapter cannot create and write files, so a copy cannot be saved');
  }
  const taken = new Set((await adapter.list(folder, { depth: 1 })).map((entry) => entry.name));
  const copyPath = joinPath(folder, uniqueName(name, taken));
  const created = await adapter.create(copyPath, 'file');
  try {
    return await adapter.write(copyPath, text, { expectedMtimeMs: created.mtimeMs });
  } catch (failure) {
    return removeEmptyCopy(adapter, copyPath, failure);
  }
}

/**
 * Save mine as a copy: creates a free `… copy` name next to the file (`create` fails rather than replace a
 * file that appeared meanwhile), writes the edited text to it (removing the empty copy if that fails), and
 * then takes theirs for the original, unless the text changed while the copy was written: then the
 * buffer, with the newer text, is kept in conflict.
 *
 * @example
 * ```ts
 * const saved = await saveCopy(host, 'notes.md');
 * ```
 */
export async function saveCopy(host: EditBufferHost, path: string): Promise<SavedCopy | undefined> {
  const buffer = host.find(path);
  if (!buffer) return undefined;
  await host.settled(buffer);
  const { adapter, store } = host.session;
  const copiedText = buffer.text;
  const copy = await writeNewCopy(adapter, parentPath(buffer.path), basename(buffer.path), copiedText);
  store.applyChanges([{ type: 'created', path: copy.path, entry: copy }]);
  if (buffer.text !== copiedText) return { copyPath: copy.path, theirVersion: undefined, editsKept: true };
  return { copyPath: copy.path, theirVersion: await takeTheirs(host, buffer.path), editsKept: false };
}

async function createdOrTaken(adapter: FileSystemAdapter, path: string): Promise<Entry | null> {
  if (!adapter.create) {
    throw new FsError('invalid', 'This adapter cannot create files, so a deleted file cannot be saved again');
  }
  try {
    return await adapter.create(path, 'file');
  } catch (failure) {
    if (toFsError(failure).kind === 'conflict') return null;
    throw failure;
  }
}

/**
 * Save for a deleted file: creates it (`create` fails rather than replace a file that is there again, which
 * puts the buffer in `conflict`), then saves the whole edited text over exactly that new, empty version,
 * also when an earlier save had already landed before the file went away.
 *
 * @example
 * ```ts
 * await recreate(host, 'notes.md');
 * ```
 */
export async function recreate(host: EditBufferHost, path: string): Promise<void> {
  const buffer = host.find(path);
  if (!buffer) return;
  await host.settled(buffer);
  const target = buffer.path;
  const created = await createdOrTaken(host.session.adapter, target);
  if (!created) {
    buffer.remote = 'conflict';
    buffer.stillOnTheServer = true;
    host.refresh(buffer);
    return;
  }
  host.session.store.applyChanges([{ type: 'created', path: target, entry: created }]);
  if (created.mtimeMs !== undefined) buffer.knownVersions.add(created.mtimeMs);
  buffer.remote = undefined;
  buffer.stillOnTheServer = true;
  buffer.autosaver.rebase(created.mtimeMs);
  buffer.autosaver.change(buffer.text);
  host.refresh(buffer);
  await buffer.autosaver.flush();
}
