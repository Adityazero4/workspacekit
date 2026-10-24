'use client';
import { isSameOrDescendant, remapPrefix } from '@workspacekit/core';
import type { UiStore } from '../provider/ui-store';
import type { TabsState } from './tabs-store';

/**
 * A stable id per open tab of a provider session, for React keys and element ids that must survive a rename
 * or move of the tab's file. Ids of tabs that close are forgotten.
 *
 * @example
 * ```tsx
 * <ViewerTab key={tabIds.idOf(tab.path)} path={tab.path} />
 * ```
 */
export interface TabIds {
  /** The tab's id, assigned on first use. */
  idOf: (path: string) => string;
  /** Moves the ids at or below `from` to below `to`; call it before the tabs themselves are remapped. */
  remap: (from: string, to: string) => void;
}

/**
 * Tab ids for the tabs in `tabs`, forgetting each one once its tab closes.
 *
 * @example
 * ```ts
 * const tabIds = createTabIds(session.tabs);
 * ```
 */
export function createTabIds(tabs: UiStore<TabsState>): TabIds {
  let ids = new Map<string, string>();
  let lastAssigned = 0;
  tabs.subscribe(() => {
    const open = new Set(tabs.get().tabs.map((tab) => tab.path));
    for (const path of ids.keys()) if (!open.has(path)) ids.delete(path);
  });
  return {
    idOf: (path) => {
      const known = ids.get(path);
      if (known !== undefined) return known;
      const assigned = String(++lastAssigned);
      ids.set(path, assigned);
      return assigned;
    },
    remap: (from, to) => {
      if (![...ids.keys()].some((path) => isSameOrDescendant(path, from))) return;
      const remapped = new Map<string, string>();
      for (const [path, id] of ids) {
        const movedPath = remapPrefix(path, from, to);
        if (!remapped.has(movedPath)) remapped.set(movedPath, id);
      }
      ids = remapped;
    },
  };
}
