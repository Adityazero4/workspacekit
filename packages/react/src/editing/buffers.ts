import {
  basename,
  entryAt,
  FsError,
  isSameOrDescendant,
  joinPath,
  parentPath,
  remapPrefix,
  uniqueName,
  type Entry,
} from '@scope/core';
import { isBeingMoved } from '../tabs/followTree';
import { isDeletedFromTree, openTab, setTabDirty } from '../tabs/tabs-store';
import { createAutosaver, hasUnsavedEdits } from './autosaver';
import {
  statusOfBuffer,
  type EditBuffer,
  type EditBufferHost,
  type EditBufferSession,
  type EditBufferState,
} from './editBuffer';
import { guardUnsavedEditsOnLeave } from './pageLifecycle';
import * as resolveConflicts from './resolveConflicts';

/**
 * The unsaved text edits of a provider session, by path. A buffer starts with the first edit, follows moves
 * and renames, and outlives its viewer and tab while it has unsaved edits.
 *
 * @example
 * ```ts
 * const reloadable = !editBuffers.isDirty(path);
 * ```
 */
export interface EditBuffers {
  /** Whether `path` has edits that are not saved yet; a viewer must not reload its text meanwhile. */
  isDirty: (path: string) => boolean;
  /** Calls `listener` after every change to any buffer. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** `path`'s buffer, or `undefined`; the same object until it changes. */
  get: (path: string) => EditBufferState | undefined;
  /** Records `text` as the edited content of `path`, edited from the file's `version` (its `mtimeMs`). */
  edit: (path: string, text: string, version: number | undefined) => void;
  /** Saves `path`'s edits now; resolves once that settles, never rejects. */
  flush: (path: string) => Promise<void>;
  /** Drops `path`'s buffer and its unsaved edits. */
  discard: (path: string) => void;
  /** Drops `path`'s buffer when nothing in it is unsaved, such as when its viewer goes away. */
  releaseIfClean: (path: string) => void;
  /** Resolves a conflict with the edited text; see `keepMine` in `resolveConflicts`. */
  keepMine: (path: string) => Promise<void>;
  /** Resolves a conflict with the server's text; resolves with their version's `mtimeMs`. */
  takeTheirs: (path: string) => Promise<number | undefined>;
  /** Writes the edited text to a new `… copy` file next to it, then takes theirs. */
  saveCopy: (path: string) => Promise<resolveConflicts.SavedCopy | undefined>;
  /** Saves a deleted file's text, creating it again once the server confirms it is gone. */
  recreate: (path: string) => Promise<void>;
  /** Whether any buffer has unsaved edits, including those whose tab was closed. */
  hasUnsavedEdits: () => boolean;
  /**
   * Starts following the tree (moves, deletions, newer versions) and the page (`pagehide` flushes every
   * buffer; `beforeunload` asks while any is dirty). Returns the stop, which also flushes and ends every
   * buffer, including text typed while a save was in flight; the buffers are dropped once those saves settle.
   */
  connect: () => () => void;
}

const isKnown = (buffer: EditBuffer, version: number | undefined): boolean =>
  version !== undefined && buffer.knownVersions.has(version);

function refusalToSave(buffer: EditBuffer, expectedMtimeMs: number | undefined): FsError | undefined {
  const { path, remote } = buffer;
  const name = basename(path);
  if (remote === 'deleted') {
    return new FsError('not_found', `"${name}" was deleted; save it to create it again`, { path });
  }
  if (remote === 'conflict') {
    return new FsError('conflict', `"${name}" was changed by someone else; keep your text or take theirs`, {
      path,
    });
  }
  if (expectedMtimeMs === undefined && buffer.stillOnTheServer) {
    return new FsError('conflict', `can't confirm the server copy of "${name}"; choose Save mine as a copy`, {
      path,
    });
  }
  return undefined;
}

class SessionEditBuffers implements EditBuffers {
  readonly #session: EditBufferSession;
  readonly #host: EditBufferHost;
  readonly #buffers = new Map<string, EditBuffer>();
  readonly #listeners = new Set<() => void>();
  #treeCheckScheduled = false;

  constructor(session: EditBufferSession) {
    this.#session = session;
    this.#host = {
      session,
      find: (path) => this.#buffers.get(path),
      refresh: (buffer) => this.#refresh(buffer),
      drop: (buffer) => this.#drop(buffer),
      settled: (buffer) => this.#settled(buffer),
    };
  }

  isDirty = (path: string): boolean => {
    const buffer = this.#buffers.get(path);
    return buffer !== undefined && hasUnsavedEdits(statusOfBuffer(buffer));
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  get = (path: string): EditBufferState | undefined => this.#buffers.get(path)?.state;

  edit = (path: string, text: string, version: number | undefined): void => {
    const buffer = this.#buffers.get(path) ?? this.#create(path, version);
    const clean = !hasUnsavedEdits(statusOfBuffer(buffer));
    if (clean && version !== undefined && !buffer.knownVersions.has(version)) {
      buffer.knownVersions.add(version);
      buffer.autosaver.rebase(version);
    }
    buffer.text = text;
    buffer.autosaver.change(text);
    this.#refresh(buffer);
  };

  flush = (path: string): Promise<void> => this.#buffers.get(path)?.autosaver.flush() ?? Promise.resolve();

  discard = (path: string): void => {
    const buffer = this.#buffers.get(path);
    if (buffer) this.#drop(buffer);
  };

  releaseIfClean = (path: string): void => {
    if (!this.isDirty(path)) this.discard(path);
  };

  keepMine = (path: string): Promise<void> => resolveConflicts.keepMine(this.#host, path);

  takeTheirs = (path: string): Promise<number | undefined> => resolveConflicts.takeTheirs(this.#host, path);

  saveCopy = (path: string): Promise<resolveConflicts.SavedCopy | undefined> =>
    resolveConflicts.saveCopy(this.#host, path);

  recreate = (path: string): Promise<void> => resolveConflicts.recreate(this.#host, path);

  hasUnsavedEdits = (): boolean => [...this.#buffers.keys()].some(this.isDirty);

  connect = (): (() => void) => {
    const { store, followedMoves, onMovedPaths } = this.#session;
    const stops = [
      store.subscribe(this.#checkEveryBufferSoon),
      followedMoves.subscribe(this.#checkEveryBufferSoon),
      onMovedPaths(this.#followMove),
      guardUnsavedEditsOnLeave({ flushAll: this.#flushEveryBuffer, hasUnsavedEdits: this.hasUnsavedEdits }),
    ];
    return () => {
      for (const stop of stops) stop();
      const lastSaves = [...this.#buffers.values()].map((buffer) =>
        buffer.autosaver.flush().finally(buffer.autosaver.dispose),
      );
      void Promise.allSettled(lastSaves).then(() => this.#buffers.clear());
    };
  };

  #create(path: string, version: number | undefined): EditBuffer {
    const buffer: EditBuffer = {
      path,
      text: '',
      autosaver: createAutosaver({
        save: (text, expectedMtimeMs) => this.#save(buffer, text, expectedMtimeMs),
        baseMtimeMs: version,
      }),
      knownVersions: new Set(version === undefined ? [] : [version]),
      seenWhileSaving: new Set(),
      remote: undefined,
      stillOnTheServer: true,
      retired: false,
      state: undefined,
    };
    buffer.autosaver.subscribe(() => this.#checkAgainstTheTree(buffer));
    this.#buffers.set(path, buffer);
    return buffer;
  }

  async #save(buffer: EditBuffer, text: string, expectedMtimeMs: number | undefined): Promise<Entry> {
    if (this.#isBeingMoved(buffer)) await this.#settled(buffer);
    if (buffer.retired || this.#buffers.get(buffer.path) !== buffer) {
      throw new FsError(
        'cancelled',
        `The edits of "${basename(buffer.path)}" were dropped before they were saved`,
      );
    }
    const refusal = refusalToSave(buffer, expectedMtimeMs);
    if (refusal) throw refusal;
    const { adapter } = this.#session;
    if (!adapter.write) {
      throw new FsError('invalid', 'This adapter cannot write files; it has no write method');
    }
    const { path } = buffer;
    const entry = await adapter.write(path, text, { expectedMtimeMs });
    this.#noteOwnWrite(buffer, path, entry);
    return entry;
  }

  #noteOwnWrite(buffer: EditBuffer, path: string, entry: Entry): void {
    if (entry.mtimeMs !== undefined) buffer.knownVersions.add(entry.mtimeMs);
    buffer.seenWhileSaving.delete(entry.mtimeMs);
    if (buffer.path !== path || buffer.remote === 'deleted') return;
    buffer.stillOnTheServer = true;
    const someoneElseWroteMeanwhile = [...buffer.seenWhileSaving].some(
      (version) => !isKnown(buffer, version),
    );
    if (!someoneElseWroteMeanwhile) this.#session.store.applyChanges([{ type: 'updated', path, entry }]);
  }

  #isBeingMoved(buffer: EditBuffer): boolean {
    return isBeingMoved(this.#session.followedMoves.get(), buffer.path);
  }

  #settled(buffer: EditBuffer): Promise<void> {
    if (!this.#isBeingMoved(buffer)) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = this.#session.followedMoves.subscribe(() => {
        if (this.#isBeingMoved(buffer)) return;
        stop();
        resolve();
      });
    });
  }

  #checkEveryBufferSoon = (): void => {
    if (this.#treeCheckScheduled) return;
    this.#treeCheckScheduled = true;
    queueMicrotask(() => {
      this.#treeCheckScheduled = false;
      for (const buffer of [...this.#buffers.values()]) this.#checkAgainstTheTree(buffer);
    });
  };

  #checkAgainstTheTree(buffer: EditBuffer): void {
    const { store, root } = this.#session;
    if (this.#buffers.get(buffer.path) !== buffer) return;
    if (!this.#isBeingMoved(buffer)) {
      const snapshot = store.getSnapshot();
      if (isDeletedFromTree(snapshot, buffer.path, root)) this.#noteDeleted(buffer);
      else this.#noteVersion(buffer, entryAt(snapshot.tree, buffer.path));
    }
    if (this.#buffers.get(buffer.path) === buffer) this.#refresh(buffer);
  }

  #noteDeleted(buffer: EditBuffer): void {
    const wasOnTheServer = buffer.stillOnTheServer;
    buffer.stillOnTheServer = false;
    if (!hasUnsavedEdits(statusOfBuffer(buffer))) this.#drop(buffer);
    else if (wasOnTheServer) buffer.remote = 'deleted';
  }

  #noteVersion(buffer: EditBuffer, entry: Entry | undefined): void {
    if (!entry) return;
    buffer.stillOnTheServer = true;
    if (buffer.remote === 'deleted') buffer.remote = undefined;
    const ownStatus = buffer.autosaver.status().kind;
    if (ownStatus === 'saving') {
      if (!isKnown(buffer, entry.mtimeMs)) buffer.seenWhileSaving.add(entry.mtimeMs);
      return;
    }
    const seen = [entry.mtimeMs, ...buffer.seenWhileSaving];
    buffer.seenWhileSaving.clear();
    if (buffer.remote || !hasUnsavedEdits(ownStatus)) return;
    if (seen.some((version) => !isKnown(buffer, version))) buffer.remote = 'conflict';
  }

  #refresh(buffer: EditBuffer): void {
    const { error } = buffer.autosaver.status();
    const status = statusOfBuffer(buffer);
    const previous = buffer.state;
    if (
      previous?.text === buffer.text &&
      previous.status === status &&
      previous.error === error &&
      previous.knownVersions.size === buffer.knownVersions.size
    ) {
      return;
    }
    buffer.state = { text: buffer.text, status, error, knownVersions: new Set(buffer.knownVersions) };
    this.#markTab(buffer.path, hasUnsavedEdits(status));
    this.#notify();
  }

  #drop(buffer: EditBuffer): void {
    buffer.retired = true;
    buffer.autosaver.dispose();
    if (this.#buffers.get(buffer.path) !== buffer) return;
    this.#buffers.delete(buffer.path);
    this.#markTab(buffer.path, false);
    this.#notify();
  }

  #followMove = (from: string, to: string): void => {
    const moving = [...this.#buffers.values()].filter(
      (buffer) => isSameOrDescendant(buffer.path, from) && remapPrefix(buffer.path, from, to) !== buffer.path,
    );
    if (moving.length === 0) return;
    for (const buffer of moving) this.#buffers.delete(buffer.path);
    for (const buffer of moving) {
      const path = remapPrefix(buffer.path, from, to);
      const replaced = this.#buffers.get(path);
      if (replaced) this.#displace(replaced);
      buffer.path = path;
      this.#buffers.set(path, buffer);
    }
    this.#notify();
  };

  #displace(buffer: EditBuffer): void {
    this.#buffers.delete(buffer.path);
    if (!hasUnsavedEdits(statusOfBuffer(buffer))) {
      buffer.autosaver.dispose();
      return;
    }
    const folder = parentPath(buffer.path);
    const listed = this.#session.store.getSnapshot().tree.folders.get(folder)?.children.keys() ?? [];
    const buffered = [...this.#buffers.keys()].filter((path) => parentPath(path) === folder).map(basename);
    const taken = new Set([basename(buffer.path), ...listed, ...buffered]);
    const path = joinPath(folder, uniqueName(basename(buffer.path), taken));
    buffer.path = path;
    buffer.remote = 'deleted';
    buffer.stillOnTheServer = false;
    buffer.seenWhileSaving.clear();
    this.#buffers.set(path, buffer);
    this.#session.tabs.set((state) => ({ ...openTab(state, path, 'pin'), active: state.active ?? path }));
    this.#markTab(path, true);
    this.#refresh(buffer);
  }

  #flushEveryBuffer = (): void => {
    for (const buffer of [...this.#buffers.values()]) void buffer.autosaver.flush();
  };

  #markTab(path: string, dirty: boolean): void {
    this.#session.tabs.set((state) => setTabDirty(state, path, dirty));
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * The edit buffers of one provider session. Each buffer autosaves through `createAutosaver` with
 * `expectedMtimeMs`, and never writes without one while the file is believed to exist. It goes to
 * `conflict` as soon as the tree shows a version of its file it does not know (or one without `mtimeMs`)
 * while it has unsaved edits, including versions seen while a save was in flight, and to `deleted` when
 * its file disappears; a clean buffer whose file is deleted is dropped. A move that replaces a file with
 * unsaved edits keeps those edits as an unsaved `… copy` beside it (status `deleted`, its tab opened), so
 * Save creates it. Saves wait while a `followMove` covers the file, so they go to its final path. Saves and
 * the conflict choices write through the session's adapter and record the written entry in the store, so
 * the tree stays current without `watch`.
 *
 * @example
 * ```ts
 * const editBuffers = createEditBuffers({ adapter, store, root, tabs, followedMoves, onMovedPaths });
 * const disconnect = editBuffers.connect();
 * ```
 */
export function createEditBuffers(session: EditBufferSession): EditBuffers {
  return new SessionEditBuffers(session);
}
