'use client';
import { entryAt, normalizePath, parentPath, type TreeStore } from '@workspacekit/core';
import type { TreeCommands } from '../actions/treeCommands';
import { useFileSystem } from '../provider/hooks';
import { useFileSystemInternals } from '../provider/internals';
import { openProviderTab } from '../tabs/useTabs';

/**
 * What `useWorkspace` returns: calls that drive the workspace from anywhere under its provider.
 *
 * @example
 * ```ts
 * const { open, reveal }: WorkspaceController = useWorkspace();
 * ```
 */
export interface WorkspaceController {
  /** Opens `path` in a tab, as a preview (the default) or pinned; see `TabsApi.open`. */
  open: (path: string, how?: 'preview' | 'pin') => void;
  /** The provider's `reveal`: expands the folders above `path`, selects it and shows it in the tree. */
  reveal: (path: string) => Promise<void>;
  /**
   * Lists a folder again from the adapter: `path` itself when it is a folder, the folder holding it when it
   * is a file, and every loaded folder without a `path`.
   */
  refresh: (path?: string) => Promise<void>;
  /** Starts the inline rename of `path` in the first mounted tree; does nothing without a tree. */
  startRename: (path: string) => void;
  /** Collapses every folder of the first mounted tree; does nothing without a tree. */
  collapseAll: () => void;
  /** Focuses the row of `path` in the first mounted tree, when it is visible; does nothing without a tree. */
  focus: (path: string) => void;
}

function folderToRefresh(store: TreeStore, path: string): string {
  const normalized = normalizePath(path);
  const { tree } = store.getSnapshot();
  const isFolder = tree.folders.has(normalized) || entryAt(tree, normalized)?.kind === 'directory';
  return isFolder ? normalized : parentPath(normalized);
}

async function refreshLoadedFolders(store: TreeStore): Promise<void> {
  const folders = [...store.getSnapshot().tree.folders.values()].filter(
    (folder) => folder.status === 'loaded' || folder.status === 'loading',
  );
  await Promise.all(folders.map((folder) => store.loadFolder(folder.path, { force: true })));
}

/**
 * Drives the workspace from any component under its `FileSystemProvider` (a viewer, a renderer, a panel of
 * your own): open tabs, reveal entries, refresh folders, and run the first mounted tree's rename, Collapse
 * all and focus. The returned object keeps its identity across renders, so it is safe in effect
 * dependencies.
 *
 * @example
 * ```tsx
 * function OpenReadme(): React.JSX.Element {
 *   const workspace = useWorkspace();
 *   return <button onClick={() => workspace.open('README.md', 'pin')}>Open the README</button>;
 * }
 * ```
 */
export function useWorkspace(): WorkspaceController {
  const fs = useFileSystem();
  const { treeCommands } = useFileSystemInternals();
  const firstTree = (): TreeCommands | null => treeCommands.current.get();
  return {
    open: (path, how) => openProviderTab(fs, path, how),
    reveal: (path) => fs.reveal(path),
    refresh: (path) =>
      path === undefined
        ? refreshLoadedFolders(fs.store)
        : fs.store.loadFolder(folderToRefresh(fs.store, path), { force: true }),
    startRename: (path) => firstTree()?.startRename(path),
    collapseAll: () => firstTree()?.collapseAll(),
    focus: (path) => firstTree()?.focus(path),
  };
}
