'use client';
import {
  entryAt,
  FsError,
  isSameOrDescendant,
  normalizePath,
  parentPath,
  statusOf,
  toFsError,
  type Entry,
  type FolderStatus,
} from '@scope/core';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sameEntryFields, useFileSystem } from '../provider/hooks';
import { useFileSystemInternals } from '../provider/internals';
import { viewerError, type ViewerError } from './registry';
import type { ShownSource } from './sources';

/**
 * The entry a viewer shows, or why there is none; both `undefined` while it is still being looked up.
 *
 * @example
 * ```ts
 * const { entry, error }: EntryLookup = useViewerEntry(path, attempt, shownHere, false);
 * ```
 */
export interface EntryLookup {
  entry: Entry | undefined;
  error: ViewerError | undefined;
}

interface TreeEntryRead {
  entry: Entry | undefined;
  parentStatus: FolderStatus;
  parentError: FsError | undefined;
}

interface OutsideTreeAnswer {
  request: string;
  entry?: Entry | null;
  error?: FsError;
}

interface Found {
  entry: Entry | undefined;
  failure: FsError | undefined;
}

function useTreeEntry(path: string): TreeEntryRead {
  const { store } = useFileSystem();
  const lastRead = useRef<TreeEntryRead | undefined>(undefined);
  const read = (): TreeEntryRead => {
    const { tree, errors } = store.getSnapshot();
    const parent = parentPath(path);
    const next = {
      entry: entryAt(tree, path),
      parentStatus: statusOf(tree, parent),
      parentError: errors.get(parent),
    };
    const previous = lastRead.current;
    if (
      previous &&
      sameEntryFields(previous.entry, next.entry) &&
      previous.parentStatus === next.parentStatus &&
      previous.parentError === next.parentError
    ) {
      return previous;
    }
    return (lastRead.current = next);
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

const keepTheStatAnswer = (): void => undefined;

function canonicalOrUndefined(path: string): string | undefined {
  try {
    return normalizePath(path);
  } catch {
    return undefined;
  }
}

function statAnswerFor(path: string, entry: Entry | null): Pick<OutsideTreeAnswer, 'entry' | 'error'> {
  if (!entry || entry.path === path) return { entry };
  if (canonicalOrUndefined(entry.path) === path) return { entry: { ...entry, path } };
  const message = `adapter.stat("${path}") answered for "${entry.path}"; it must answer for the path it is asked`;
  return { error: new FsError('invalid', message, { path }) };
}

function useEntryOutsideTheTree(
  path: string,
  needed: boolean,
  attempt: number,
): OutsideTreeAnswer | undefined {
  const { adapter, store } = useFileSystem();
  const [answer, setAnswer] = useState<OutsideTreeAnswer>();
  const requestedFor = useRef<string | undefined>(undefined);
  const request = `${attempt}:${path}`;
  useEffect(() => {
    if (!needed || requestedFor.current === request) return;
    requestedFor.current = request;
    if (!adapter.stat) {
      store
        .loadFolder(parentPath(path))
        .catch((error: unknown) => setAnswer({ request, error: toFsError(error) }));
      return;
    }
    const controller = new AbortController();
    let settled = false;
    const settle = (result: Pick<OutsideTreeAnswer, 'entry' | 'error'>): void => {
      settled = true;
      if (!controller.signal.aborted) setAnswer({ request, ...result });
    };
    adapter.stat(path, { signal: controller.signal }).then(
      (answered) => {
        const { entry, error } = statAnswerFor(path, answered);
        settle({ entry, error });
        if (entry && !controller.signal.aborted) {
          store.loadFolder(parentPath(path)).catch(keepTheStatAnswer);
        }
      },
      (error: unknown) => settle({ error: toFsError(error) }),
    );
    return () => {
      controller.abort();
      if (!settled) requestedFor.current = undefined;
    };
  }, [adapter, store, path, needed, request]);
  return answer?.request === request ? answer : undefined;
}

function useSeenSincePathChange(path: string, entry: Entry | undefined): boolean {
  const [tracked, setTracked] = useState({ path, seen: entry !== undefined });
  if (tracked.path !== path || (entry !== undefined && !tracked.seen)) {
    setTracked({ path, seen: entry !== undefined });
  }
  return entry !== undefined || (tracked.path === path && tracked.seen);
}

function useFollowedMoveCovers(path: string): boolean {
  const { followedMoves } = useFileSystemInternals();
  const read = (): boolean =>
    [...followedMoves.get()].some(
      (move) => isSameOrDescendant(path, move.from) || isSameOrDescendant(path, move.to),
    );
  return useSyncExternalStore(followedMoves.subscribe, read, read);
}

function foundEntry(
  tree: TreeEntryRead,
  outside: OutsideTreeAnswer | undefined,
  canStat: boolean,
): Found | undefined {
  if (tree.parentStatus === 'loaded') return { entry: tree.entry, failure: undefined };
  if (outside) return { entry: outside.entry ?? undefined, failure: outside.error };
  if (!canStat && tree.parentError) return { entry: undefined, failure: tree.parentError };
  return undefined;
}

/**
 * Finds the entry at `path`: from the tree while its folder is loaded (re-rendering only when this entry or
 * that folder's status changes), otherwise with one `adapter.stat`, or one load of the folder when the
 * adapter has no `stat`, per path and `attempt`. A `stat` answer whose path does not normalize to `path` is
 * a `load_error`, not asked again until `attempt` changes. An entry found with `stat` also starts one
 * background load of its folder, so watch events and polling keep it live; a failed listing leaves the
 * `stat` answer as is.
 * A missing entry is `deleted` when it, or a source for it (`shownHere`), was there since `path` last
 * changed, and `not_found` otherwise. While a `followMove`
 * covering `path` is in flight, or the lookup is still running, or `keepShown` is set (the shown text has
 * unsaved edits), a missing entry falls back to the one `shownHere` was loaded from, so a moved file stays
 * on screen and a deleted file keeps its edits.
 *
 * @example
 * ```ts
 * const { entry, error } = useViewerEntry(path, attempt, shownAt(loader.getSnapshot().shown, path), false);
 * ```
 */
export function useViewerEntry(
  path: string,
  attempt: number,
  shownHere: ShownSource | undefined,
  keepShown: boolean,
): EntryLookup {
  const { adapter } = useFileSystem();
  const tree = useTreeEntry(path);
  const parentLoaded = tree.parentStatus === 'loaded';
  const outside = useEntryOutsideTheTree(path, !parentLoaded && tree.parentStatus !== 'loading', attempt);
  const found = foundEntry(tree, outside, adapter.stat !== undefined);
  const seen = useSeenSincePathChange(path, found?.entry) || shownHere !== undefined;
  const moving = useFollowedMoveCovers(path);
  if (found?.entry) return { entry: found.entry, error: undefined };
  if (found?.failure && found.failure.kind !== 'not_found') {
    return { entry: undefined, error: viewerError('load_error', found.failure) };
  }
  if (!found || ((moving || keepShown) && shownHere)) return { entry: shownHere?.entry, error: undefined };
  return { entry: undefined, error: viewerError(seen ? 'deleted' : 'not_found') };
}
