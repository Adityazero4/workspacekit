'use client';
import {
  createTreeStore,
  entryAt,
  isSameOrDescendant,
  normalizePath,
  remapPrefix,
  statusOf,
  toFsError,
  type FileSystemAdapter,
  type FsError,
  type SortSpec,
  type TreeSnapshot,
  type TreeStore,
  type UploadOptions,
} from '@scope/core';
import { useEffect, useState, type ReactNode } from 'react';
import type { ClipboardItem } from '../actions/clipboard';
import { forgetStateOfTheReplacedEntry, type FollowedMove } from '../actions/followMove';
import { createConflictQueue, type ConflictQueue } from '../dialogs/conflicts';
import { closeTabsOfDeletedFiles } from '../tabs/followTree';
import { NO_TABS, remapTabs, type Tab, type TabsState } from '../tabs/tabs-store';
import { createUploads, type UploadsController } from '../uploads/uploads';
import { FsContext, type FileSystemContext, type Notice } from './hooks';
import { registerInternals } from './internals';
import { createPersister, readPersisted } from './persist';
import { createRevealer, foldersBetween, type Reveal, type RevealHost } from './reveal';
import { createUiStore, type UiStore } from './ui-store';

/**
 * Props of `FileSystemProvider`.
 *
 * @example
 * ```tsx
 * const props: FileSystemProviderProps = {
 *   adapter,
 *   storageKey: `my-app:${workspaceId}`,
 *   children: <FileTree />,
 * };
 * ```
 */
export interface FileSystemProviderProps {
  adapter: FileSystemAdapter;
  /** Mount a subtree (store root). */
  root?: string;
  /** Default 2. */
  fetchDepth?: number;
  /**
   * Persists the expanded set, sort, showHidden and open tabs. Use a key that identifies the workspace (for
   * example tenant plus workspace id), because the persisted state belongs to that workspace. The provider
   * does not persist the pane size: `SplitPane` does, under the same key when `Workspace` passes it this one.
   */
  storageKey?: string;
  /** Basenames hidden by default; default ['.git','node_modules','__pycache__','.DS_Store']. */
  hidden?: readonly string[];
  onNotify?: (notice: Notice) => void;
  /** Every FsError except `cancelled`, including the tree store's load failures. */
  onError?: (error: FsError) => void;
  /**
   * What an upload does when a file's name is already taken: `'replace'`, `'keepBoth'` (upload it under a
   * free `… copy` name) or `'skip'`, or a function asked once per conflicting path. By default the first
   * mounted `FileTree` asks in its conflict dialog (Keep both, Replace or Skip; Escape skips that file, and
   * "Apply to all" answers the rest of the run); with no tree mounted, the upload keeps both.
   */
  onUploadConflict?: UploadOptions['onConflict'];
  children: ReactNode;
}

const DEFAULT_HIDDEN: readonly string[] = ['.git', 'node_modules', '__pycache__', '.DS_Store'];
const DEFAULT_SORT: SortSpec = { by: 'name', direction: 'asc' };
const SORT_BY: readonly string[] = ['name', 'extension', 'mtime', 'size'];
const noop = (): void => undefined;

const isNormalizedPath = (path: string): boolean => {
  try {
    return normalizePath(path) === path;
  } catch {
    return false;
  }
};
const parsePersistedExpanded = (value: unknown, root: string): string[] =>
  Array.isArray(value)
    ? value.filter(
        (path): path is string =>
          typeof path === 'string' && isNormalizedPath(path) && isSameOrDescendant(path, root),
      )
    : [];
const parsePersistedSort = (value: unknown): SortSpec => {
  const sort = value as Partial<SortSpec> | undefined;
  return sort &&
    SORT_BY.includes(sort.by as string) &&
    (sort.direction === 'asc' || sort.direction === 'desc')
    ? { by: sort.by!, direction: sort.direction }
    : DEFAULT_SORT;
};
const isPersistedTab = (value: unknown, root: string): value is Pick<Tab, 'path' | 'preview'> => {
  const tab = value as Partial<Tab> | null;
  return (
    typeof tab?.path === 'string' &&
    typeof tab.preview === 'boolean' &&
    isNormalizedPath(tab.path) &&
    tab.path !== root &&
    isSameOrDescendant(tab.path, root)
  );
};
const parsePersistedTabs = (value: unknown, root: string): TabsState => {
  const persisted = value as Partial<TabsState> | null;
  if (!Array.isArray(persisted?.tabs)) return NO_TABS;
  const tabs = new Map<string, Tab>();
  for (const tab of persisted.tabs as unknown[]) {
    if (isPersistedTab(tab, root)) tabs.set(tab.path, { path: tab.path, preview: tab.preview, dirty: false });
  }
  const active = typeof persisted.active === 'string' && tabs.has(persisted.active) ? persisted.active : null;
  return { tabs: [...tabs.values()], active: active ?? tabs.keys().next().value ?? null };
};

const hiddenNamesFromKey = (joinedNames: string): { joinedNames: string; names: ReadonlySet<string> } => ({
  joinedNames,
  names: new Set(joinedNames === '' ? [] : joinedNames.split('\0')),
});

type Callbacks = Pick<FileSystemProviderProps, 'onNotify' | 'onError' | 'onUploadConflict'>;

interface Session {
  adapter: FileSystemAdapter;
  root: string;
  fetchDepth: number;
  storageKey: string | undefined;
  store: TreeStore;
  expanded: UiStore<ReadonlySet<string>>;
  selected: UiStore<string | null>;
  sort: UiStore<SortSpec>;
  showHidden: UiStore<boolean>;
  clipboard: UiStore<ClipboardItem | null>;
  tabs: UiStore<TabsState>;
  followedMoves: UiStore<ReadonlySet<FollowedMove>>;
  uploads: UploadsController;
  conflicts: ConflictQueue;
  reveal: Reveal;
  isRevealing: () => boolean;
  attachRevealHost: (host: RevealHost) => () => void;
  updateCallbacks: (callbacks: Callbacks) => void;
  recreate: () => Session;
  restoredAwaitingFirstLoad: Set<string>;
  expandedFoldersSeenByTheLoader: ReadonlySet<string>;
  remapMovedPaths: (from: string, to: string) => void;
  report: (error: FsError) => void;
  notify: (notice: Notice) => void;
}

function createSession(
  adapter: FileSystemAdapter,
  root: string,
  fetchDepth: number,
  storageKey: string | undefined,
  initialCallbacks: Callbacks,
): Session {
  let callbacks = initialCallbacks;
  const alreadyReported = new WeakSet<FsError>();
  const report = (error: FsError): void => {
    if (error.kind === 'cancelled' || alreadyReported.has(error)) return;
    alreadyReported.add(error);
    callbacks.onError?.(error);
  };
  const restoredAwaitingFirstLoad = new Set<string>();
  const expanded = createUiStore<ReadonlySet<string>>(new Set());
  const forgetVanishedRestoredFolder = (error: FsError): boolean => {
    if (error.kind !== 'not_found' && error.kind !== 'invalid') return false;
    for (const path of restoredAwaitingFirstLoad) {
      if (session.store.getSnapshot().errors.get(path) !== error) continue;
      restoredAwaitingFirstLoad.delete(path);
      expanded.set((previous) => new Set([...previous].filter((expandedPath) => expandedPath !== path)));
      return true;
    }
    return false;
  };
  const notify = (notice: Notice): void => {
    callbacks.onNotify?.(notice);
    if (notice.error) report(notice.error);
  };
  const store = createTreeStore(adapter, {
    root,
    fetchDepth,
    onError: (error) => {
      if (!forgetVanishedRestoredFolder(error)) report(error);
    },
  });
  const conflicts = createConflictQueue();
  const selected = createUiStore<string | null>(null);
  const revealer = createRevealer({ store, root: normalizePath(root), expanded, selected });
  const session: Session = {
    adapter,
    root,
    fetchDepth,
    storageKey,
    store,
    expanded,
    selected,
    sort: createUiStore(DEFAULT_SORT),
    showHidden: createUiStore(false),
    clipboard: createUiStore<ClipboardItem | null>(null),
    tabs: createUiStore(NO_TABS),
    followedMoves: createUiStore<ReadonlySet<FollowedMove>>(new Set()),
    uploads: createUploads({
      adapter,
      store,
      notify,
      report,
      conflictPolicy: () => callbacks.onUploadConflict,
      conflicts,
    }),
    conflicts,
    reveal: revealer.reveal,
    isRevealing: revealer.isRevealing,
    attachRevealHost: revealer.attachHost,
    updateCallbacks: (latest) => void (callbacks = latest),
    recreate: () => createSession(adapter, root, fetchDepth, storageKey, callbacks),
    restoredAwaitingFirstLoad,
    expandedFoldersSeenByTheLoader: new Set(),
    remapMovedPaths: (from, to) => remapMovedPathsInSession(session, from, to),
    report,
    notify,
  };
  registerInternals(store, session);
  return session;
}

function remapPaths(paths: ReadonlySet<string>, from: string, to: string): ReadonlySet<string> {
  const remapped = new Set([...paths].map((path) => remapPrefix(path, from, to)));
  const membershipChanged = remapped.size !== paths.size || [...remapped].some((path) => !paths.has(path));
  return membershipChanged ? remapped : paths;
}

function remapMovedPathsInSession(session: Session, from: string, to: string): void {
  session.expandedFoldersSeenByTheLoader = remapPaths(session.expandedFoldersSeenByTheLoader, from, to);
  const restored = remapPaths(session.restoredAwaitingFirstLoad, from, to);
  if (restored !== session.restoredAwaitingFirstLoad) {
    session.restoredAwaitingFirstLoad.clear();
    for (const path of restored) session.restoredAwaitingFirstLoad.add(path);
  }
  session.expanded.set((previous) => remapPaths(previous, from, to));
  session.selected.set((previous) => (previous === null ? previous : remapPrefix(previous, from, to)));
  session.clipboard.set((item) => {
    if (!item) return item;
    const path = remapPrefix(item.path, from, to);
    return path === item.path ? item : { ...item, path };
  });
  session.tabs.set((state) => remapTabs(state, from, to));
}

function followCommittedMove(session: Session, from: string, to: string): void {
  const followedByFollowMove = [...session.followedMoves.get()].some(
    (move) => move.from === from && move.to === to,
  );
  if (followedByFollowMove) return;
  forgetStateOfTheReplacedEntry(session, to);
  remapMovedPathsInSession(session, from, to);
}

function isSessionFor(
  session: Session,
  adapter: FileSystemAdapter,
  root: string,
  fetchDepth: number,
  storageKey: string | undefined,
): boolean {
  return (
    session.adapter === adapter &&
    session.root === root &&
    Object.is(session.fetchDepth, fetchDepth) &&
    session.storageKey === storageKey
  );
}

const disposedStores = new WeakSet<TreeStore>();

function restorePersistedState(session: Session): void {
  const { storageKey } = session;
  if (!storageKey) return;
  const restored = parsePersistedExpanded(readPersisted(storageKey, 'expanded'), normalizePath(session.root));
  for (const path of restored) session.restoredAwaitingFirstLoad.add(path);
  session.expanded.set(new Set(restored));
  session.sort.set(parsePersistedSort(readPersisted(storageKey, 'sort')));
  session.showHidden.set(readPersisted(storageKey, 'hidden') === true);
  session.tabs.set(parsePersistedTabs(readPersisted(storageKey, 'tabs'), normalizePath(session.root)));
}

function persistUiState(session: Session): () => void {
  if (!session.storageKey) return noop;
  const persister = createPersister(session.storageKey);
  const { expanded, sort, showHidden, tabs } = session;
  const unsubscribes = [
    expanded.subscribe(() => persister.write('expanded', [...expanded.get()])),
    sort.subscribe(() => persister.write('sort', sort.get())),
    showHidden.subscribe(() => persister.write('hidden', showHidden.get())),
    tabs.subscribe(() => persister.write('tabs', tabs.get())),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    persister.dispose();
  };
}

function isIdleSettledFolder(snapshot: TreeSnapshot, path: string): boolean {
  return (
    statusOf(snapshot.tree, path) === 'idle' &&
    entryAt(snapshot.tree, path)?.kind === 'directory' &&
    !snapshot.pending.has(path)
  );
}

function loadExpandedFoldersAfterRoot(session: Session): () => void {
  const { store, expanded, restoredAwaitingFirstLoad } = session;
  const reportFailure = (error: unknown): void => session.report(toFsError(error));
  let mounted = true;
  let rootSettled = false;
  const loadExpandedFoldersThatNeedIt = (): void => {
    if (!rootSettled) return;
    const current = expanded.get();
    const snapshot = store.getSnapshot();
    for (const path of current) {
      const seen = session.expandedFoldersSeenByTheLoader.has(path);
      if (seen && !isIdleSettledFolder(snapshot, path)) continue;
      if (statusOf(snapshot.tree, path) === 'loaded') restoredAwaitingFirstLoad.delete(path);
      else {
        void store
          .loadFolder(path)
          .catch(reportFailure)
          .finally(() => restoredAwaitingFirstLoad.delete(path));
      }
    }
    session.expandedFoldersSeenByTheLoader = current;
  };
  const root = normalizePath(session.root);
  const loadFoldersAboveTab = async (tab: Tab): Promise<void> => {
    if (tab.path === root || !isSameOrDescendant(tab.path, root)) return;
    for (const folder of foldersBetween(root, tab.path)) {
      if (!mounted || entryAt(store.getSnapshot().tree, folder)?.kind !== 'directory') return;
      await store.loadFolder(folder).catch(reportFailure);
      if (statusOf(store.getSnapshot().tree, folder) !== 'loaded') return;
    }
  };
  const stopFollowingExpanded = expanded.subscribe(loadExpandedFoldersThatNeedIt);
  const stopFollowingStore = store.subscribe(loadExpandedFoldersThatNeedIt);
  void store
    .loadFolder(session.root)
    .catch(reportFailure)
    .finally(() => {
      rootSettled = mounted;
      loadExpandedFoldersThatNeedIt();
      for (const tab of session.tabs.get().tabs) void loadFoldersAboveTab(tab);
    });
  return () => {
    mounted = rootSettled = false;
    stopFollowingExpanded();
    stopFollowingStore();
  };
}

function startSession(session: Session, replace: () => void): (() => void) | undefined {
  const { store } = session;
  const disposedByStrictModeCleanup = disposedStores.has(store);
  if (disposedByStrictModeCleanup) {
    replace();
    return undefined;
  }
  const stopWatching = store.subscribe(noop);
  const stopFollowingMoves = store.onMove((from, to) => followCommittedMove(session, from, to));
  restorePersistedState(session);
  const stopPersisting = persistUiState(session);
  const stopClosingDeletedTabs = closeTabsOfDeletedFiles(
    store,
    normalizePath(session.root),
    session.tabs,
    session.followedMoves,
  );
  const stopLoading = loadExpandedFoldersAfterRoot(session);
  return () => {
    stopLoading();
    stopClosingDeletedTabs();
    stopFollowingMoves();
    stopPersisting();
    stopWatching();
    session.uploads.cancelAll();
    store.dispose();
    disposedStores.add(store);
  };
}

function useHiddenNameSet(hidden: readonly string[]): ReadonlySet<string> {
  const joinedNames = hidden.join('\0');
  const [current, setCurrent] = useState(() => hiddenNamesFromKey(joinedNames));
  if (current.joinedNames !== joinedNames) setCurrent(hiddenNamesFromKey(joinedNames));
  return current.names;
}

function applyDefaultsOutsideParametersForReactCompiler(props: FileSystemProviderProps) {
  return {
    ...props,
    root: props.root ?? '',
    fetchDepth: props.fetchDepth ?? 2,
    hidden: props.hidden ?? DEFAULT_HIDDEN,
  };
}

/**
 * Owns the tree store for `adapter` (and `root`) plus the shared UI state, and provides them to every
 * file-system component below it. Children render on the server too (with an empty tree); loading, watching
 * and restoring persisted state start after mount, so the server and the first client render agree.
 *
 * The store and the UI state belong to one session per (adapter, root, fetchDepth, storageKey): changing any
 * of them starts a fresh session, so one workspace's expanded, selected, clipboard and tab state never leaks
 * into another. Persisted values are read before the new key's persister exists, and only well-formed values
 * are accepted, since anyone can edit storage. A restored folder that no longer exists (or is now a file) is
 * dropped quietly instead of failing every startup; once the root listing settles, the folders above each
 * restored tab are loaded top-down, so a tab whose file no longer exists closes quietly too. A newly expanded
 * folder is loaded unless it already is; the first pass waits for the root listing, which usually covers the
 * first levels. An expanded folder whose load was discarded (it was renamed or moved mid-load) is loaded
 * again once the move settles. The session also owns the uploader (see `useUploads`); ending the session
 * cancels its running uploads.
 *
 * Path-keyed state (expanded folders, the selection, the clipboard entry and the open tabs) follows every
 * committed move or rename the store reports (`store.onMove`), except the exact `from`/`to` pair of a
 * `followMove` in flight, which moves that state itself. For every other move, such as one made by someone
 * else, the state of an entry it replaced (selection, clipboard entry, expanded folders inside it) is dropped
 * first, then the moved entry's state moves. A followed move the server completes under another name is
 * reported under that name and falls through to this too, which changes nothing: `followMove` has already
 * moved the state to `to`, so nothing is left below `from` or inside the new name. Open tabs also follow
 * deletions: a clean tab closes once a loaded listing shows its file is gone (unless a followed move
 * involving it is in flight); a dirty one stays open.
 *
 * Defaults are applied in the body, not in the parameter pattern: React Compiler 1.0 skips a component with
 * parameter-pattern defaults, silently. The build test checks that every exported component and hook stays
 * compiled.
 *
 * @example
 * ```tsx
 * <FileSystemProvider adapter={httpAdapter('/api/fs')} storageKey="my-app">
 *   <FileTree />
 * </FileSystemProvider>
 * ```
 */
export function FileSystemProvider(props: FileSystemProviderProps): React.JSX.Element {
  const { adapter, root, fetchDepth, storageKey, hidden, onNotify, onError, onUploadConflict, children } =
    applyDefaultsOutsideParametersForReactCompiler(props);
  const createCurrentSession = (): Session =>
    createSession(adapter, root, fetchDepth, storageKey, { onNotify, onError, onUploadConflict });
  const [session, setSession] = useState(createCurrentSession);
  if (!isSessionFor(session, adapter, root, fetchDepth, storageKey)) setSession(createCurrentSession());

  useEffect(() => session.updateCallbacks({ onNotify, onError, onUploadConflict }));
  useEffect(() => startSession(session, () => setSession(session.recreate())), [session]);

  const hiddenNames = useHiddenNameSet(hidden);
  const value: FileSystemContext = {
    adapter: session.adapter,
    store: session.store,
    root: normalizePath(session.root),
    expanded: session.expanded,
    selected: session.selected,
    sort: session.sort,
    showHidden: session.showHidden,
    hiddenNames,
    clipboard: session.clipboard,
    tabs: session.tabs,
    reveal: session.reveal,
    notify: session.notify,
  };
  return <FsContext value={value}>{children}</FsContext>;
}
