'use client';
import {
  basename,
  entryAt,
  isSameOrDescendant,
  joinPath,
  parentPath,
  uniqueName,
  validateName,
  validateTransfer,
  type Entry,
  type TreeTransferOptions,
} from '@workspacekit/core';
import { useSyncExternalStore } from 'react';
import { isUnchangedSince, replaceRefusedMessage } from '../dialogs/conflicts';
import { useFileSystem, type FileSystemContext } from '../provider/hooks';
import { internalsOf } from '../provider/internals';
import { followMove } from './followMove';
import { entryOnTheServer } from './serverEntry';

/**
 * What the clipboard holds: one entry, cut or copied.
 *
 * @example
 * ```ts
 * const item: ClipboardItem = { op: 'cut', path: 'src/a.ts' };
 * ```
 */
export interface ClipboardItem {
  op: 'cut' | 'copy';
  path: string;
}

/**
 * The provider's in-app clipboard (not the system clipboard). One per workspace session.
 *
 * @example
 * ```ts
 * const { clipboard } = useFileSystem();
 * clipboard.set({ op: 'copy', path: 'a.txt' });
 * ```
 */
export interface Clipboard {
  get: () => ClipboardItem | null;
  set: (item: ClipboardItem | null) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Whether `path` is the cut entry on the clipboard; re-renders only when that changes.
 *
 * @example
 * ```tsx
 * const isCut = useIsCut(path);
 * ```
 */
export function useIsCut(path: string): boolean {
  const { clipboard } = useFileSystem();
  const read = (): boolean => {
    const item = clipboard.get();
    return item?.op === 'cut' && item.path === path;
  };
  return useSyncExternalStore(clipboard.subscribe, read, read);
}

async function namesIn(fs: FileSystemContext, folder: string): Promise<Set<string>> {
  await fs.store.loadFolder(folder);
  return new Set(fs.store.getSnapshot().tree.folders.get(folder)?.children.keys() ?? []);
}

async function siblingWithTheSameName(
  fs: FileSystemContext,
  folder: string,
  name: string,
): Promise<Entry | undefined> {
  await fs.store.loadFolder(folder);
  const siblings = fs.store.getSnapshot().tree.folders.get(folder)?.children.values() ?? [];
  return [...siblings].find((sibling) => validateName(name, new Set([sibling.name])) === 'duplicate');
}

async function replacedEntryIsUnchanged(fs: FileSystemContext, existing: Entry): Promise<boolean> {
  const current = await entryOnTheServer(fs.adapter, existing.path).catch(() => undefined);
  if (isUnchangedSince(existing, current)) return true;
  void fs.store.loadFolder(parentPath(existing.path), { force: true }).catch(() => undefined);
  fs.notify({
    kind: 'error',
    message: replaceRefusedMessage(existing.path, existing, 'nothing was replaced'),
  });
  return false;
}

/**
 * How a transfer into a folder ended: `done`, `noop` (a move into the folder it is already in), `cancelled`
 * (the user cancelled the conflict dialog, or the entry to replace changed meanwhile) or `refused` (into
 * itself; a notice says so).
 *
 * @example
 * ```ts
 * const outcome: TransferOutcome = await transferInto(fs, {
 *   op: 'move',
 *   path: 'a.txt',
 *   folder: 'docs',
 *   verb: 'move',
 * });
 * ```
 */
export type TransferOutcome = 'done' | 'noop' | 'cancelled' | 'refused';

/**
 * What `transferInto` moves or copies, where to, and the user's gesture (`verb`), which its notices name.
 *
 * @example
 * ```ts
 * const transfer: Transfer = { op: 'copy', path: 'a.txt', folder: 'docs', verb: 'paste' };
 * ```
 */
export interface Transfer {
  op: 'move' | 'copy';
  path: string;
  folder: string;
  verb: 'paste' | 'move' | 'copy';
}

async function transferOntoExisting(
  fs: FileSystemContext,
  transfer: Transfer,
  existing: Entry,
): Promise<TransferOutcome> {
  const { op, path, folder } = transfer;
  const answer = await internalsOf(fs).conflicts.ask(op, existing.path, {
    existing,
    incoming: entryAt(fs.store.getSnapshot().tree, path)?.kind,
    canReplace: !isSameOrDescendant(path, existing.path),
  });
  if (!answer || answer.choice === 'skip') return 'cancelled';
  if (answer.choice === 'replace' && !(await replacedEntryIsUnchanged(fs, existing))) return 'cancelled';
  const name =
    answer.choice === 'replace' ? existing.name : uniqueName(basename(path), await namesIn(fs, folder));
  const options: TreeTransferOptions = { name, overwrite: answer.choice === 'replace' };
  if (op === 'copy') {
    await fs.store.copy(path, folder, options);
    return 'done';
  }
  await followMove(fs, path, joinPath(folder, name), () => fs.store.move(path, folder, options));
  return 'done';
}

/**
 * Moves or copies `path` into `folder`, the one validation path for paste and drag and drop: a move has
 * expanded folders and the selection follow it, and a copy into its own folder gets a free `… copy` name.
 * Onto an existing name (compared like `validateName`, so `Readme.md` meets `README.md`) it asks in the
 * conflict dialog about that entry: Replace overwrites exactly it, Keep both uses a free `… copy` name (a
 * move moves under it in one call), and Cancel changes nothing. Replace is not offered across kinds (a file
 * onto a folder) or onto a folder that contains the source, and it is refused with a notice when the entry on
 * the server changed while the dialog was open or cannot be read. A transfer into itself is refused with a
 * notice that names `verb` (the user's gesture).
 *
 * @example
 * ```ts
 * await transferInto(fs, { op: 'copy', path: 'a.txt', folder: 'docs', verb: 'copy' });
 * ```
 */
export async function transferInto(fs: FileSystemContext, transfer: Transfer): Promise<TransferOutcome> {
  const { op, path, folder, verb } = transfer;
  const name = basename(path);
  const problem = validateTransfer(op, path, folder);
  if (problem === 'into_self') {
    fs.notify({ kind: 'error', message: `Can't ${verb} "${name}" into itself. Choose another folder.` });
    return 'refused';
  }
  if (problem === 'noop') return 'noop';
  const copiesInPlace = op === 'copy' && parentPath(path) === folder;
  const existing = copiesInPlace ? undefined : await siblingWithTheSameName(fs, folder, name);
  if (existing) return transferOntoExisting(fs, transfer, existing);
  if (op === 'move') {
    await followMove(fs, path, joinPath(folder, name), () => fs.store.move(path, folder));
  } else {
    await fs.store.copy(path, folder);
  }
  return 'done';
}

/**
 * Pastes the clipboard entry into `folder` through `transferInto`: a cut moves it (and empties the clipboard
 * unless the paste was refused or cancelled), a copy copies it.
 *
 * @example
 * ```ts
 * await pasteInto(fs, 'src');
 * ```
 */
export async function pasteInto(fs: FileSystemContext, folder: string): Promise<void> {
  const item = fs.clipboard.get();
  if (!item) return;
  const op = item.op === 'cut' ? 'move' : 'copy';
  const outcome = await transferInto(fs, { op, path: item.path, folder, verb: 'paste' });
  if (op === 'move' && (outcome === 'done' || outcome === 'noop')) fs.clipboard.set(null);
}
