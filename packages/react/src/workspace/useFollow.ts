'use client';
import { entryAt } from '@workspacekit/core';
import { useEffect } from 'react';
import { useFileSystem, type FileSystemContext } from '../provider/hooks';
import { useFileSystemInternals, type FileSystemInternals } from '../provider/internals';
import { isUnderAHiddenName } from '../search/useFileSearch';
import { openTab } from '../tabs/tabs-store';

const FOLLOW_INTERVAL_MS = 500;

type FollowedSession = Pick<
  FileSystemContext,
  'store' | 'root' | 'reveal' | 'tabs' | 'showHidden' | 'hiddenNames'
> &
  Pick<FileSystemInternals, 'isRevealing'>;

const latestSequence = (session: FollowedSession): number =>
  session.store.getSnapshot().latestExternalChange?.sequence ?? 0;

function isShownInTheTree(session: FollowedSession, path: string): boolean {
  if (!entryAt(session.store.getSnapshot().tree, path)) return false;
  return session.showHidden.get() || !isUnderAHiddenName(path, session.root, session.hiddenNames);
}

const revealWasCancelledOrFailed = (): void => undefined;

function followChanges(session: FollowedSession): () => void {
  const { store, reveal, isRevealing, tabs } = session;
  let followedSequence = latestSequence(session);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const openIfFile = (path: string): void => {
    if (stopped || entryAt(store.getSnapshot().tree, path)?.kind !== 'file') return;
    tabs.set((state) => openTab(state, path, 'preview'));
  };
  const scheduleCheck = (): void => {
    timer ??= setTimeout(followTheLatestChange, FOLLOW_INTERVAL_MS);
  };
  function followTheLatestChange(): void {
    timer = undefined;
    if (isRevealing()) {
      scheduleCheck();
      return;
    }
    const latest = store.getSnapshot().latestExternalChange;
    if (!latest || latest.sequence === followedSequence) return;
    followedSequence = latest.sequence;
    const { path } = latest;
    if (!isShownInTheTree(session, path)) return;
    reveal(path, { flash: true, focus: false }).then(() => openIfFile(path), revealWasCancelledOrFailed);
  }
  const stopWatching = store.subscribe(() => {
    if (latestSequence(session) !== followedSequence) scheduleCheck();
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopWatching();
  };
}

/**
 * Follow mode: while `enabled`, the latest change someone else (an agent) makes to an entry the tree shows
 * (see `TreeSnapshot.latestExternalChange`) is revealed with a flash, without moving focus, and a file is
 * opened as a preview tab. Changes are checked at most once per 500 ms, the latest one winning; a repeated
 * change to a path is followed again, while moves of marked paths (such as the user renaming their folder)
 * are not changes. A check that finds a reveal in flight (the user's own, from search) waits for the next
 * window instead of replacing it, and one whose entry is gone, or under a hidden name while Show hidden is
 * off, is skipped. Changes made before follow turns on are not followed; turning it off, or unmounting,
 * cancels a pending check.
 *
 * @example
 * ```ts
 * useFollow(follow);
 * ```
 */
export function useFollow(enabled: boolean): void {
  const { store, root, reveal, tabs, showHidden, hiddenNames } = useFileSystem();
  const { isRevealing } = useFileSystemInternals();
  useEffect(
    () =>
      enabled
        ? followChanges({ store, root, reveal, isRevealing, tabs, showHidden, hiddenNames })
        : undefined,
    [enabled, store, root, reveal, isRevealing, tabs, showHidden, hiddenNames],
  );
}
