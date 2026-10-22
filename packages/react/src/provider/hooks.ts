'use client';
import {
  entryAt,
  statusOf,
  type Entry,
  type FileSystemAdapter,
  type FolderStatus,
  type FsError,
  type SortSpec,
  type TreeSnapshot,
  type TreeStore,
} from '@scope/core';
import { createContext, useContext, useRef, useSyncExternalStore, type Context } from 'react';
import type { Clipboard } from '../actions/clipboard';
import type { TabsState } from '../tabs/tabs-store';
import type { Reveal } from './reveal';
import type { UiStore } from './ui-store';

/**
 * A user-facing message components report through `notify`; `error` is also passed to `onError`.
 *
 * @example
 * ```tsx
 * notify({ kind: 'error', message: 'Could not rename the file', error });
 * ```
 */
export interface Notice {
  kind: 'success' | 'info' | 'error';
  message: string;
  error?: FsError;
}

const MAX_REASON_LENGTH = 500;

function reasonFrom(message: string): string {
  const reason = message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}…` : message;
  let end = reason.length;
  while (end > 0 && reason[end - 1] === '.') end--;
  return reason.slice(0, end);
}

/**
 * The message of an error notice: `<failure>: <reason>. Try again.`. The reason is the error's message (which
 * can come from a server) cut to 500 characters, with "…" when cut, and without its own closing periods, so
 * the sentence never ends in two. Runs in linear time on any message.
 *
 * @example
 * ```ts
 * notify({ kind: 'error', message: failureMessage('Search failed', error), error });
 * ```
 */
export function failureMessage(failure: string, error: FsError): string {
  return `${failure}: ${reasonFrom(error.message)}. Try again.`;
}

/**
 * What `useFileSystem` returns: the adapter, the tree store and the shared UI-state stores.
 *
 * @example
 * ```tsx
 * const { store, selected }: FileSystemContext = useFileSystem();
 * ```
 */
export interface FileSystemContext {
  adapter: FileSystemAdapter;
  store: TreeStore;
  /** The store root, normalized (`''` for the whole file system). */
  root: string;
  expanded: UiStore<ReadonlySet<string>>;
  selected: UiStore<string | null>;
  sort: UiStore<SortSpec>;
  showHidden: UiStore<boolean>;
  hiddenNames: ReadonlySet<string>;
  /** The in-app clipboard for cut, copy and paste. */
  clipboard: Clipboard;
  /** The open tabs; read and change them with `useTabs`. */
  tabs: UiStore<TabsState>;
  /**
   * Shows the entry at `path`: loads every folder above it, top-down (each one once, with `store.loadFolder`;
   * a folder that was already loaded but lacks the next part of the path is reloaded once, in case it is
   * stale), expands them, selects the entry and marks it seen. With `expand`, a folder entry is expanded too.
   * The first mounted `FileTree` then scrolls the row into view and focuses it, even when focus is elsewhere
   * (such as a search box), unless `focus` is `false` (then focus stays where it is, for a reveal the user
   * did not ask for), and with `flash` marks it `data-flash`. With no tree mounted, the folders are still
   * expanded and the entry selected. An entry under a hidden name (see `hidden`) is expanded and selected but
   * not shown while Show hidden is off; reveal never turns Show hidden on, and the tree never takes focus for
   * it later.
   *
   * Rejects with `FsError` `not_found` (naming the missing part of the path) when the entry or a folder above
   * it does not exist, with the folder's load error when a listing fails, with `invalid` for a path outside
   * the root (which leaves a reveal in flight alone), and with `cancelled` when a later `reveal` replaces it:
   * the latest call wins, so an earlier one never moves focus or selection after it. Treat `cancelled` as
   * "nothing to do".
   */
  reveal: Reveal;
  notify: (notice: Notice) => void;
  /**
   * Whether any file has edits that are not saved, including files whose tab was closed. Use it to guard
   * navigation in the app: ending the session (unmounting the provider, or a new adapter or root) drops
   * edits that could not be saved, such as those in conflict, deleted or failing to save.
   */
  hasUnsavedEdits: () => boolean;
  /** Calls `listener` whenever any file's edits or save status change. Returns the unsubscribe. */
  subscribeToEdits: (listener: () => void) => () => void;
}

/**
 * What `useEntryState` returns for one path.
 *
 * @example
 * ```tsx
 * const { entry, pending }: EntryState = useEntryState(path);
 * ```
 */
export interface EntryState {
  entry?: Entry;
  status: FolderStatus;
  pending: boolean;
  changed: boolean;
  /** Whether a path below this folder is in `changed`. */
  changedBelow: boolean;
  error?: FsError;
}

/**
 * Internal: set by `FileSystemProvider`.
 *
 * @example
 * ```tsx
 * <FsContext value={fileSystemContext}>{children}</FsContext>
 * ```
 */
export const FsContext: Context<FileSystemContext | null> = createContext<FileSystemContext | null>(null);

/**
 * The nearest `FileSystemProvider`'s adapter, tree store and UI-state stores.
 * Throws when called outside a provider.
 *
 * @example
 * ```tsx
 * const { store, expanded } = useFileSystem();
 * expanded.set((s) => new Set(s).add('src'));
 * ```
 */
export function useFileSystem(): FileSystemContext {
  const ctx = useContext(FsContext);
  if (!ctx) {
    throw new Error(
      'useFileSystem() was called outside <FileSystemProvider>. Wrap the component (or its parent) in ' +
        '<FileSystemProvider adapter={yourAdapter}>…</FileSystemProvider>.',
    );
  }
  return ctx;
}

/**
 * The whole tree snapshot; re-renders on every store change. Prefer `useEntryState` for per-row reads.
 *
 * @example
 * ```tsx
 * const { tree, pending } = useTreeSnapshot();
 * ```
 */
export function useTreeSnapshot(): TreeSnapshot {
  const { store } = useFileSystem();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Whether two entries (or `undefined`) have equal fields: `meta` is compared by identity, the rest by value.
 *
 * @internal
 * @example
 * ```ts
 * if (sameEntryFields(previous.entry, entry)) return previous;
 * ```
 */
export const sameEntryFields = (a: Entry | undefined, b: Entry | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.path === b.path &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.meta === b.meta);

/**
 * One path's entry, folder status, pending, changed and changed-below flags and load error. Re-renders only
 * when one of those changes, so a listing that rebuilds sibling entries with equal values does not re-render
 * their rows. Entry fields are compared one by one, and `meta` by identity.
 *
 * @example
 * ```tsx
 * const { entry, status, pending } = useEntryState('src/index.ts');
 * ```
 */
export function useEntryState(path: string): EntryState {
  const { store } = useFileSystem();
  const lastReturned = useRef<EntryState | undefined>(undefined);
  const read = (): EntryState => {
    const snapshot = store.getSnapshot();
    const entry = entryAt(snapshot.tree, path);
    const status = statusOf(snapshot.tree, path);
    const pending = snapshot.pending.has(path);
    const changed = snapshot.changed.has(path);
    const changedBelow = snapshot.changedBelow.has(path);
    const error = snapshot.errors.get(path);
    const previous = lastReturned.current;
    if (
      previous &&
      sameEntryFields(previous.entry, entry) &&
      previous.status === status &&
      previous.pending === pending &&
      previous.changed === changed &&
      previous.changedBelow === changedBelow &&
      previous.error === error
    ) {
      return previous;
    }
    const next: EntryState = { status, pending, changed, changedBelow };
    if (entry) next.entry = entry;
    if (error) next.error = error;
    return (lastReturned.current = next);
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/**
 * The current value of a `UiStore`, re-rendering when it changes.
 *
 * @example
 * ```tsx
 * const { sort } = useFileSystem();
 * const spec = useUiValue(sort);
 * ```
 */
export function useUiValue<T>(store: UiStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Whether `path` is expanded; re-renders only when that changes.
 *
 * @example
 * ```tsx
 * const open = useExpanded('src');
 * ```
 */
export function useExpanded(path: string): boolean {
  const { expanded } = useFileSystem();
  const get = (): boolean => expanded.get().has(path);
  return useSyncExternalStore(expanded.subscribe, get, get);
}

/**
 * Whether `path` is the selected entry; re-renders only when that changes.
 *
 * @example
 * ```tsx
 * const isSelected = useSelected('src/index.ts');
 * ```
 */
export function useSelected(path: string): boolean {
  const { selected } = useFileSystem();
  const get = (): boolean => selected.get() === path;
  return useSyncExternalStore(selected.subscribe, get, get);
}
