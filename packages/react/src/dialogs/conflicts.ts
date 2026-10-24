'use client';
import type { ConflictChoice, Entry, EntryKind } from '@workspacekit/core';
import { useFileSystemInternals } from '../provider/internals';
import { createUiStore, type UiStore } from '../provider/ui-store';

/**
 * What ran into an existing name: a move, a copy or an upload.
 *
 * @example
 * ```ts
 * const kind: ConflictKind = 'upload';
 * ```
 */
export type ConflictKind = 'move' | 'copy' | 'upload';

/**
 * The user's answer to a conflict. `applyToAll` asks the caller to give the same answer to its remaining
 * conflicts.
 *
 * @example
 * ```ts
 * const answer: ConflictAnswer = { choice: 'keepBoth', applyToAll: false };
 * ```
 */
export interface ConflictAnswer {
  choice: ConflictChoice;
  applyToAll: boolean;
}

/**
 * What the conflict dialog needs to know besides the path, so it offers only answers that can work.
 *
 * @example
 * ```ts
 * const details: ConflictDetails = { existing, incoming: 'file', remaining: 2 };
 * ```
 */
export interface ConflictDetails {
  /** How many more conflicts the caller may still ask about; above 0 the dialog offers "Apply to all". */
  remaining?: number;
  /**
   * The entry already at the path. A folder there makes the dialog warn that Replace deletes everything in
   * it.
   */
  existing?: Entry;
  /** What would replace it. When it and `existing` are of different kinds, Replace is not offered. */
  incoming?: EntryKind;
  /**
   * `false` when replacing can never work, such as replacing a folder that contains the source. Default
   * `true`.
   */
  canReplace?: boolean;
}

/**
 * Asks the user what to do about `path`, which already exists; resolves with `null` when they cancel.
 *
 * @example
 * ```ts
 * const answer = await resolveConflict('copy', 'docs/a.txt', { existing, incoming: 'file' });
 * ```
 */
export type ConflictResolver = (
  kind: ConflictKind,
  path: string,
  opts?: ConflictDetails,
) => Promise<ConflictAnswer | null>;

/**
 * One question waiting in the conflict queue.
 *
 * @internal
 * @example
 * ```ts
 * request.settle({ choice: 'replace', applyToAll: false });
 * ```
 */
export interface ConflictRequest {
  id: number;
  kind: ConflictKind;
  path: string;
  remaining: number;
  existing?: Entry;
  /** Whether the dialog offers Replace. */
  offersReplace: boolean;
  settle: (answer: ConflictAnswer | null) => void;
}

/**
 * The provider's conflict questions, shown one at a time by the first mounted tree (the host).
 *
 * @internal
 * @example
 * ```ts
 * const detach = conflicts.attachHost(host);
 * const shown = conflicts.requests.get()[0];
 * ```
 */
export interface ConflictQueue {
  ask: ConflictResolver;
  /** Waiting questions, oldest first; the host shows the first one. */
  requests: UiStore<readonly ConflictRequest[]>;
  /** Mounted hosts, in mount order; the first one shows the questions. */
  hosts: UiStore<readonly object[]>;
  /** Hosts with a menu or dialog of their own open; no question shows while there is one. */
  busyHosts: UiStore<ReadonlySet<object>>;
  /**
   * Registers a host; the returned detach settles every waiting question with `null` once no host is left.
   */
  attachHost: (host: object) => () => void;
  setHostBusy: (host: object, busy: boolean) => void;
  /** Takes an answered question off the queue, so the next one shows; the host settles it itself. */
  dismiss: (request: ConflictRequest) => void;
}

/**
 * Creates the conflict queue of one provider session. Without a mounted host nothing can ask, so `ask`
 * resolves with `null` straight away.
 *
 * @internal
 * @example
 * ```ts
 * const conflicts = createConflictQueue();
 * const answer = await conflicts.ask('move', 'docs/a.txt');
 * ```
 */
export function createConflictQueue(): ConflictQueue {
  const requests = createUiStore<readonly ConflictRequest[]>([]);
  const hosts = createUiStore<readonly object[]>([]);
  const busyHosts = createUiStore<ReadonlySet<object>>(new Set());
  const setHostBusy = (host: object, busy: boolean): void => {
    if (busyHosts.get().has(host) === busy) return;
    busyHosts.set((previous) => {
      const next = new Set(previous);
      if (busy) next.add(host);
      else next.delete(host);
      return next;
    });
  };
  let lastId = 0;
  const settleEveryWaitingRequest = (): void => {
    const waiting = requests.get();
    requests.set([]);
    for (const request of waiting) request.settle(null);
  };
  return {
    requests,
    hosts,
    busyHosts,
    ask: (kind, path, opts = {}) => {
      if (hosts.get().length === 0) return Promise.resolve(null);
      const { existing, incoming, remaining = 0, canReplace = true } = opts;
      const kindsMatch = existing === undefined || incoming === undefined || existing.kind === incoming;
      return new Promise((settle) => {
        const request: ConflictRequest = {
          id: ++lastId,
          kind,
          path,
          remaining,
          existing,
          offersReplace: canReplace && kindsMatch,
          settle,
        };
        requests.set((previous) => [...previous, request]);
      });
    },
    setHostBusy,
    attachHost: (host) => {
      hosts.set((previous) => [...previous, host]);
      return () => {
        hosts.set((previous) => previous.filter((attached) => attached !== host));
        setHostBusy(host, false);
        if (hosts.get().length === 0) settleEveryWaitingRequest();
      };
    },
    dismiss: (request) => requests.set((previous) => previous.filter((waiting) => waiting !== request)),
  };
}

const canConfirmUnchanged = (entry: Entry): boolean =>
  (entry.size !== undefined && entry.size !== null) || entry.mtimeMs !== undefined;

/**
 * Whether `current` is still the entry the user saw when the conflict was raised: same kind, size and
 * modification time. A Replace approved for `seen` must not overwrite anything else, so the check fails
 * closed: it is `false` when `current` could not be read (pass `undefined` after a failed refresh), and when
 * `seen` has neither a size nor a modification time, since nothing could then show that it changed.
 *
 * @internal
 * @example
 * ```ts
 * if (!isUnchangedSince(existing, await entryOnTheServer(adapter, existing.path))) notify(changedNotice);
 * ```
 */
export function isUnchangedSince(seen: Entry, current: Entry | null | undefined): boolean {
  return (
    canConfirmUnchanged(seen) &&
    current !== null &&
    current !== undefined &&
    current.kind === seen.kind &&
    current.size === seen.size &&
    current.mtimeMs === seen.mtimeMs
  );
}

/**
 * Why a Replace of the entry at `path` was refused, ending with what happened instead (`consequence`) and
 * what to do next. `seen` is the entry the dialog showed, if it could be read.
 *
 * @internal
 * @example
 * ```ts
 * notify({ kind: 'error', message: replaceRefusedMessage(existing.path, existing, 'nothing was replaced') });
 * ```
 */
export function replaceRefusedMessage(path: string, seen: Entry | undefined, consequence: string): string {
  if (!seen) {
    return `"${path}" could not be read when the dialog asked, so ${consequence}. Choose Keep both instead.`;
  }
  if (!canConfirmUnchanged(seen)) {
    return (
      `Can't confirm "${path}" hasn't changed, because the storage reports neither its size nor its ` +
      `modification time, so ${consequence}. Choose Keep both instead.`
    );
  }
  return `"${path}" changed while the dialog was open, or could not be checked, so ${consequence}. Try again.`;
}

/**
 * Asks the user what to do when a move, copy or upload meets an existing name, in the conflict dialog of the
 * nearest provider's first mounted `FileTree`. Questions are queued, so only one dialog is open at a time;
 * each resolves with the answer, or `null` when the user cancels, the tree unmounts, or no tree is mounted.
 *
 * @example
 * ```tsx
 * const resolveConflict = useConflictResolver();
 * const answer = await resolveConflict('copy', 'docs/a.txt');
 * if (answer?.choice === 'replace') await store.copy('a.txt', 'docs', { overwrite: true });
 * ```
 */
export function useConflictResolver(): ConflictResolver {
  const { conflicts } = useFileSystemInternals();
  return conflicts.ask;
}
