'use client';
import { isSameOrDescendant, normalizePath } from '@scope/core';
import { useFileSystem, useUiValue, type FileSystemContext } from '../provider/hooks';
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  openTab,
  pinTab,
  setTabDirty,
  type TabsState,
} from './tabs-store';

/**
 * What `useTabs` returns: the open tabs and the calls that change them. Paths are normalized first. None of
 * the calls asks for confirmation, even for a dirty tab; `FileTabs` asks before its own closes.
 *
 * @example
 * ```tsx
 * const { tabs, active, open }: TabsApi = useTabs();
 * ```
 */
export interface TabsApi extends TabsState {
  /**
   * Opens and activates `path`; a preview (the default) replaces the existing preview tab. The store root
   * itself and paths outside it are ignored, as they are when tabs are restored.
   */
  open: (path: string, how?: 'preview' | 'pin') => void;
  pin: (path: string) => void;
  close: (path: string) => void;
  closeOthers: (path: string) => void;
  activate: (path: string) => void;
  /**
   * Marks the tab's dirty indicator (a dirty tab is pinned). It only mirrors: `FileViewer`'s edit buffers
   * set it themselves and own whether edits are unsaved (`useFileSystem().hasUnsavedEdits`), so call it
   * only for a custom editor that keeps its own unsaved state.
   */
  setDirty: (path: string, dirty: boolean) => void;
}

/**
 * `TabsApi.open` without subscribing to the tabs: opens and activates `path` in the provider's tabs, unless
 * it is the store root or outside it.
 *
 * @example
 * ```ts
 * openProviderTab(useFileSystem(), 'src/index.ts', 'pin');
 * ```
 */
export function openProviderTab(
  fs: Pick<FileSystemContext, 'tabs' | 'root'>,
  path: string,
  how?: 'preview' | 'pin',
): void {
  const normalized = normalizePath(path);
  if (normalized === fs.root || !isSameOrDescendant(normalized, fs.root)) return;
  fs.tabs.set((current) => openTab(current, normalized, how));
}

/**
 * The provider's open tabs (the state an uncontrolled `FileTabs` shows), re-rendering when they change. They
 * are kept per session like the other UI state, persisted under `storageKey`, and follow the tree: a rename
 * or move remaps them, and a deleted file's tab closes unless it is dirty. A controlled `FileTabs` (one given
 * `tabs`) neither reads nor changes this state.
 *
 * Wire a tree to it with `onOpenFile`: a click previews a file, a double click or Enter pins it.
 *
 * @example
 * ```tsx
 * const tabs = useTabs();
 * <FileTree onOpenFile={(entry, how) => tabs.open(entry.path, how)} />
 * ```
 */
export function useTabs(): TabsApi {
  const fs = useFileSystem();
  const { tabs } = fs;
  const state = useUiValue(tabs);
  return {
    ...state,
    open: (path, how) => openProviderTab(fs, path, how),
    pin: (path) => tabs.set((current) => pinTab(current, normalizePath(path))),
    close: (path) => tabs.set((current) => closeTab(current, normalizePath(path))),
    closeOthers: (path) => tabs.set((current) => closeOtherTabs(current, normalizePath(path))),
    activate: (path) => tabs.set((current) => activateTab(current, normalizePath(path))),
    setDirty: (path, dirty) => tabs.set((current) => setTabDirty(current, normalizePath(path), dirty)),
  };
}
