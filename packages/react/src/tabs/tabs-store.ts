import {
  entryAt,
  isSameOrDescendant,
  parentPath,
  remapPrefix,
  statusOf,
  type TreeSnapshot,
} from '@scope/core';

/**
 * One open file in the tab strip. A preview tab (shown in italics) is replaced by the next preview; `dirty`
 * means the editor holds unsaved changes.
 *
 * @example
 * ```ts
 * const tab: Tab = { path: 'src/index.ts', preview: false, dirty: false };
 * ```
 */
export interface Tab {
  path: string;
  preview: boolean;
  dirty: boolean;
}

/**
 * The open tabs, in strip order, and the active tab's path.
 *
 * @example
 * ```ts
 * const state: TabsState = { tabs: [{ path: 'a.txt', preview: true, dirty: false }], active: 'a.txt' };
 * ```
 */
export interface TabsState {
  tabs: readonly Tab[];
  active: string | null;
}

/**
 * The tab state with no open tabs.
 *
 * @example
 * ```ts
 * const [tabs, setTabs] = useState<TabsState>(NO_TABS);
 * ```
 */
export const NO_TABS: TabsState = { tabs: [], active: null };

/**
 * Something that holds a `TabsState` and takes updates: a `UiStore`, or the controlled `FileTabs` state.
 *
 * @example
 * ```ts
 * const holder: TabsHolder = createUiStore<TabsState>(NO_TABS);
 * ```
 */
export interface TabsHolder {
  get: () => TabsState;
  set: (update: (state: TabsState) => TabsState) => void;
}

const indexOfTab = (state: TabsState, path: string): number =>
  state.tabs.findIndex((tab) => tab.path === path);

const replacedAt = (tabs: readonly Tab[], index: number, tab: Tab): Tab[] =>
  tabs.map((existing, existingIndex) => (existingIndex === index ? tab : existing));

function withTab(state: TabsState, path: string, change: (tab: Tab) => Tab): TabsState {
  const index = indexOfTab(state, path);
  if (index < 0) return state;
  const changed = change(state.tabs[index]!);
  return changed === state.tabs[index] ? state : { ...state, tabs: replacedAt(state.tabs, index, changed) };
}

const pinned = (tab: Tab): Tab => (tab.preview ? { ...tab, preview: false } : tab);

/**
 * Opens `path` and activates it. A new preview tab replaces the existing preview tab in place; a new pinned
 * tab is added at the end. An open tab is only activated, and pinned when `how` is `'pin'`.
 *
 * @example
 * ```ts
 * const next = openTab(state, 'src/index.ts', 'pin');
 * ```
 */
export function openTab(state: TabsState, path: string, how: 'preview' | 'pin' = 'preview'): TabsState {
  if (indexOfTab(state, path) >= 0) {
    const opened = how === 'pin' ? withTab(state, path, pinned) : state;
    return activateTab(opened, path);
  }
  const tab: Tab = { path, preview: how === 'preview', dirty: false };
  const previewIndex = how === 'preview' ? state.tabs.findIndex((existing) => existing.preview) : -1;
  const tabs = previewIndex >= 0 ? replacedAt(state.tabs, previewIndex, tab) : [...state.tabs, tab];
  return { tabs, active: path };
}

/**
 * Turns the preview tab at `path` into a pinned one.
 *
 * @example
 * ```ts
 * const next = pinTab(state, 'src/index.ts');
 * ```
 */
export function pinTab(state: TabsState, path: string): TabsState {
  return withTab(state, path, pinned);
}

/**
 * Activates the open tab at `path`; unknown paths change nothing.
 *
 * @example
 * ```ts
 * const next = activateTab(state, 'src/index.ts');
 * ```
 */
export function activateTab(state: TabsState, path: string): TabsState {
  return state.active === path || indexOfTab(state, path) < 0 ? state : { ...state, active: path };
}

/**
 * Closes the tab at `path`. Closing the active tab activates its right neighbour, or its left one when it was
 * last.
 *
 * @example
 * ```ts
 * const next = closeTab(state, 'src/index.ts');
 * ```
 */
export function closeTab(state: TabsState, path: string): TabsState {
  const index = indexOfTab(state, path);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  const neighbour = tabs[index] ?? tabs[index - 1];
  return { tabs, active: state.active === path ? (neighbour?.path ?? null) : state.active };
}

/**
 * Closes every tab except the one at `path`, and activates it.
 *
 * @example
 * ```ts
 * const next = closeOtherTabs(state, 'src/index.ts');
 * ```
 */
export function closeOtherTabs(state: TabsState, path: string): TabsState {
  const index = indexOfTab(state, path);
  if (index < 0 || (state.tabs.length === 1 && state.active === path)) return state;
  return { tabs: [state.tabs[index]!], active: path };
}

/**
 * Marks the tab at `path` dirty or clean; a dirty tab is pinned, so a preview never replaces unsaved changes.
 *
 * @example
 * ```ts
 * const next = setTabDirty(state, 'src/index.ts', true);
 * ```
 */
export function setTabDirty(state: TabsState, path: string, dirty: boolean): TabsState {
  return withTab(state, path, (tab) => {
    const next = dirty ? pinned(tab) : tab;
    return next.dirty === dirty ? next : { ...next, dirty };
  });
}

/**
 * Moves the tabs at or below `from` to below `to`. When a moved tab lands on a path that is already open, the
 * two merge into the earlier one, which stays dirty if either was.
 *
 * @example
 * ```ts
 * const next = remapTabs(state, 'src', 'lib');
 * ```
 */
export function remapTabs(state: TabsState, from: string, to: string): TabsState {
  if (!state.tabs.some((tab) => remapPrefix(tab.path, from, to) !== tab.path)) return state;
  const tabs: Tab[] = [];
  const indexByPath = new Map<string, number>();
  for (const tab of state.tabs) {
    const path = remapPrefix(tab.path, from, to);
    const earlier = indexByPath.get(path);
    if (earlier === undefined) {
      indexByPath.set(path, tabs.length);
      tabs.push(path === tab.path ? tab : { ...tab, path });
      continue;
    }
    const kept = tabs[earlier]!;
    tabs[earlier] = { path, preview: kept.preview && tab.preview, dirty: kept.dirty || tab.dirty };
  }
  return { tabs, active: state.active === null ? null : remapPrefix(state.active, from, to) };
}

/**
 * Whether the snapshot shows that `path` no longer exists: the loaded listing of its folder lacks it, or that
 * of a folder above it lacks that folder (or lists it as a file). A path outside `root`, one whose folders
 * are not loaded yet, or one that a pending operation is moving or creating, is not deleted.
 *
 * @example
 * ```ts
 * const gone = isDeletedFromTree(store.getSnapshot(), 'src/index.ts', root);
 * ```
 */
export function isDeletedFromTree(snapshot: TreeSnapshot, path: string, root: string): boolean {
  if (!isSameOrDescendant(path, root)) return false;
  for (let current = path; current !== root; current = parentPath(current)) {
    if (snapshot.pending.has(current)) return false;
    if (statusOf(snapshot.tree, parentPath(current)) !== 'loaded') continue;
    const entry = entryAt(snapshot.tree, current);
    return entry === undefined || (current !== path && entry.kind === 'file');
  }
  return false;
}

/**
 * Closes the clean tabs whose files `isDeletedFromTree` reports deleted; dirty ones stay open, and so do tabs
 * for which `isBeingMoved` is true (a move in flight can briefly leave a tab's path missing).
 *
 * @example
 * ```ts
 * tabs.set((state) => withDeletedCleanTabsClosed(state, store.getSnapshot(), root, () => false));
 * ```
 */
export function withDeletedCleanTabsClosed(
  state: TabsState,
  snapshot: TreeSnapshot,
  root: string,
  isBeingMoved: (path: string) => boolean,
): TabsState {
  let next = state;
  for (const tab of state.tabs) {
    const deleted = !isBeingMoved(tab.path) && isDeletedFromTree(snapshot, tab.path, root);
    if (!tab.dirty && deleted) next = closeTab(next, tab.path);
  }
  return next;
}
