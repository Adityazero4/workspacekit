import { isSameOrDescendant, type TreeStore } from '@scope/core';
import type { FollowedMove } from '../actions/followMove';
import type { UiStore } from '../provider/ui-store';
import { withDeletedCleanTabsClosed, type TabsHolder } from './tabs-store';

/**
 * Whether `path` is at or below the source or destination of a move `followMove` has in flight.
 *
 * @example
 * ```ts
 * if (isBeingMoved(followedMoves.get(), tab.path)) return;
 * ```
 */
export function isBeingMoved(moves: ReadonlySet<FollowedMove>, path: string): boolean {
  for (const move of moves) {
    if (isSameOrDescendant(path, move.from) || isSameOrDescendant(path, move.to)) return true;
  }
  return false;
}

/**
 * Keeps `tabs` following the tree: closes the clean tabs of deleted files now, after every store change, and
 * whenever a followed move settles. Tabs at or below a move in flight are left alone until it settles.
 * Returns the unsubscribe.
 *
 * @example
 * ```ts
 * const stop = closeTabsOfDeletedFiles(store, root, tabs, followedMoves);
 * ```
 */
export function closeTabsOfDeletedFiles(
  store: TreeStore,
  root: string,
  tabs: TabsHolder,
  followedMoves: UiStore<ReadonlySet<FollowedMove>>,
): () => void {
  const closeDeleted = (): void =>
    tabs.set((state) =>
      withDeletedCleanTabsClosed(state, store.getSnapshot(), root, (path) =>
        isBeingMoved(followedMoves.get(), path),
      ),
    );
  closeDeleted();
  const stopFollowingStore = store.subscribe(closeDeleted);
  const stopFollowingMoves = followedMoves.subscribe(closeDeleted);
  return () => {
    stopFollowingStore();
    stopFollowingMoves();
  };
}
