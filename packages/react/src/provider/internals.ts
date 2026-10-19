'use client';
import type { TreeStore } from '@scope/core';
import type { FollowedMove } from '../actions/followMove';
import type { ConflictQueue } from '../dialogs/conflicts';
import type { UploadsController } from '../uploads/uploads';
import { useFileSystem, type FileSystemContext } from './hooks';
import type { RevealHost } from './reveal';
import type { UiStore } from './ui-store';

/**
 * The parts of a provider session that only this package uses. They are kept out of `FileSystemContext`, so
 * they never appear in the public types.
 *
 * @example
 * ```ts
 * const { conflicts } = internalsOf(fs);
 * ```
 */
export interface FileSystemInternals {
  /** The moves `followMove` has in flight; the provider leaves the state of these exact pairs to it. */
  followedMoves: UiStore<ReadonlySet<FollowedMove>>;
  /** The session's uploads; components read them with `useUploads`. */
  uploads: UploadsController;
  /** The session's conflict questions; components ask them with `useConflictResolver`. */
  conflicts: ConflictQueue;
  /**
   * Whether the latest `reveal` is still loading its folders; a reveal the user did not ask for (follow mode)
   * waits for it instead of replacing it.
   */
  isRevealing: () => boolean;
  /** Registers a tree that shows revealed rows; the first one attached does. Returns the detach. */
  attachRevealHost: (host: RevealHost) => () => void;
  /**
   * Moves the path-keyed UI state (expanded folders, the selection, the clipboard entry, the open tabs) from
   * below `from` to below `to`. Use `followMove`, which pairs the calls around the store call; an unpaired
   * call can leave a folder expanded but never loaded.
   */
  remapMovedPaths: (from: string, to: string) => void;
}

const internalsOfSessionStore = new WeakMap<TreeStore, FileSystemInternals>();

/**
 * Records the internals of the provider session that owns `store`.
 *
 * @example
 * ```ts
 * registerInternals(store, {
 *   followedMoves,
 *   uploads,
 *   conflicts,
 *   isRevealing,
 *   attachRevealHost,
 *   remapMovedPaths,
 * });
 * ```
 */
export function registerInternals(store: TreeStore, internals: FileSystemInternals): void {
  internalsOfSessionStore.set(store, internals);
}

/**
 * The internals of the provider session `fs` came from, for code that is not a hook (such as `followMove`).
 *
 * @example
 * ```ts
 * internalsOf(fs).remapMovedPaths('src', 'lib');
 * ```
 */
export function internalsOf(fs: Pick<FileSystemContext, 'store'>): FileSystemInternals {
  const internals = internalsOfSessionStore.get(fs.store);
  if (!internals) {
    throw new Error(
      'This file-system context does not come from <FileSystemProvider>. Read it with useFileSystem() inside ' +
        '<FileSystemProvider adapter={yourAdapter}>…</FileSystemProvider>.',
    );
  }
  return internals;
}

/**
 * The nearest `FileSystemProvider`'s internals. Throws when called outside a provider.
 *
 * @example
 * ```tsx
 * const { uploads } = useFileSystemInternals();
 * ```
 */
export function useFileSystemInternals(): FileSystemInternals {
  return internalsOf(useFileSystem());
}
