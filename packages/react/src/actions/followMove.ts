'use client';
import { entryAt, isSameOrDescendant, type Entry } from '@scope/core';
import type { FileSystemContext } from '../provider/hooks';
import { internalsOf } from '../provider/internals';
import { withMembership } from '../provider/ui-store';

/**
 * A move `followMove` has in flight; the provider leaves its path-keyed state to `followMove`.
 *
 * @internal
 * @example
 * ```ts
 * const move: FollowedMove = { from: 'src', to: 'lib' };
 * ```
 */
export interface FollowedMove {
  from: string;
  to: string;
}

/**
 * Drops the state of an entry that a move replaced: the expanded folders inside it, and the selection and
 * clipboard entry at or below it.
 *
 * @internal
 * @example
 * ```ts
 * forgetStateOfTheReplacedEntry(fs, 'dir/a.txt');
 * ```
 */
export function forgetStateOfTheReplacedEntry(
  state: Pick<FileSystemContext, 'expanded' | 'selected' | 'clipboard'>,
  replaced: string,
): void {
  const isInsideReplaced = (path: string): boolean => path !== replaced && isSameOrDescendant(path, replaced);
  state.expanded.set((previous) =>
    [...previous].some(isInsideReplaced)
      ? new Set([...previous].filter((path) => !isInsideReplaced(path)))
      : previous,
  );
  state.selected.set((previous) =>
    previous !== null && isSameOrDescendant(previous, replaced) ? null : previous,
  );
  const item = state.clipboard.get();
  if (item && isSameOrDescendant(item.path, replaced)) state.clipboard.set(null);
}

async function moveWithStateFollowing(
  fs: FileSystemContext,
  from: string,
  to: string,
  move: () => Promise<Entry>,
): Promise<Entry> {
  const { remapMovedPaths } = internalsOf(fs);
  if (entryAt(fs.store.getSnapshot().tree, to)) {
    const moved = await move();
    forgetStateOfTheReplacedEntry(fs, moved.path);
    remapMovedPaths(from, moved.path);
    return moved;
  }
  remapMovedPaths(from, to);
  try {
    const moved = await move();
    remapMovedPaths(to, moved.path);
    return moved;
  } catch (error) {
    remapMovedPaths(to, from);
    throw error;
  }
}

/**
 * Runs `move`, a store rename or move of `from` to `to`, with the path-keyed UI state following it: expanded
 * folders, the selection, the clipboard entry and the open tabs move to `to` before the store call (so
 * nothing flashes collapsed), to the entry's final path once it resolves, and back to `from` if it fails.
 * Custom actions that move or rename entries should go through it.
 *
 * When `to` is taken (a Replace), the state moves only once the move succeeds, so a failure leaves both
 * entries' state as it was; on success the selection and clipboard entry of the entry at the path the move
 * landed on, and the expanded folders inside it, are dropped first. While the move is in flight the provider
 * leaves this state alone: it neither applies the store's report of this exact `from` to `to` move
 * (`store.onMove`) nor closes tabs at or below `from` or `to` whose files look deleted. Moves to other paths
 * are still followed, except that while `move` is a store move, the store takes a watch `moved` event from
 * the same `from` for its echo and does not report it (see `TreeStore.onMove`).
 *
 * @example
 * ```ts
 * await followMove(fs, 'src', 'lib', () => fs.store.rename('src', 'lib'));
 * ```
 */
export async function followMove(
  fs: FileSystemContext,
  from: string,
  to: string,
  move: () => Promise<Entry>,
): Promise<Entry> {
  const followed: FollowedMove = { from, to };
  const { followedMoves } = internalsOf(fs);
  followedMoves.set((moves) => withMembership(moves, [followed], true));
  try {
    return await moveWithStateFollowing(fs, from, to, move);
  } finally {
    followedMoves.set((moves) => withMembership(moves, [followed], false));
  }
}
