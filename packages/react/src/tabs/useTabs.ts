'use client';
import { isSameOrDescendant, normalizePath } from '@scope/core';
import { useFileSystem, useUiValue } from '../provider/hooks';
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
  /** Editors call this when their buffer gains or loses unsaved changes; a dirty tab is pinned. */
  setDirty: (path: string, dirty: boolean) => void;
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
  const { tabs, root } = useFileSystem();
  const state = useUiValue(tabs);
  return {
    ...state,
    open: (path, how) => {
      const normalized = normalizePath(path);
      if (normalized === root || !isSameOrDescendant(normalized, root)) return;
      tabs.set((current) => openTab(current, normalized, how));
    },
    pin: (path) => tabs.set((current) => pinTab(current, normalizePath(path))),
    close: (path) => tabs.set((current) => closeTab(current, normalizePath(path))),
    closeOthers: (path) => tabs.set((current) => closeOtherTabs(current, normalizePath(path))),
    activate: (path) => tabs.set((current) => activateTab(current, normalizePath(path))),
    setDirty: (path, dirty) => tabs.set((current) => setTabDirty(current, normalizePath(path), dirty)),
  };
}
