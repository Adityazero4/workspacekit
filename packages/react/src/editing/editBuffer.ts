import type { FileSystemAdapter, FsError, TreeStore } from '@scope/core';
import type { FollowedMove } from '../actions/followMove';
import type { UiStore } from '../provider/ui-store';
import type { TabsState } from '../tabs/tabs-store';
import type { Autosaver, SaveStatusKind } from './autosaver';

/**
 * What one path's edit buffer holds: the edited text, its save status, the error of the last failed save,
 * and every version of the file (`mtimeMs`) the text is known to be based on: the one it was edited from,
 * the ones its saves wrote, and the server's version after Keep mine.
 *
 * @example
 * ```ts
 * const buffer: EditBufferState | undefined = editBuffers.get('notes.md');
 * ```
 */
export interface EditBufferState {
  text: string;
  status: SaveStatusKind;
  error: FsError | undefined;
  knownVersions: ReadonlySet<number>;
}

/**
 * What a session's edit buffers work with: the adapter saves go through (the polling-wrapped one, so a save
 * is never mistaken for someone else's change), the tree store, the provider's tabs (their `dirty` mirrors
 * the buffers) and the move signals.
 *
 * @example
 * ```ts
 * const session: EditBufferSession = { adapter, store, root, tabs, followedMoves, onMovedPaths };
 * ```
 */
export interface EditBufferSession {
  adapter: FileSystemAdapter;
  store: TreeStore;
  root: string;
  tabs: UiStore<TabsState>;
  followedMoves: UiStore<ReadonlySet<FollowedMove>>;
  onMovedPaths: (listener: (from: string, to: string) => void) => () => void;
}

/**
 * One path's edit buffer, as the buffers and the conflict choices change it. `remote` is set when the file
 * changed (`conflict`) or disappeared (`deleted`) on the server; `stillOnTheServer` is whether the file is
 * believed to exist, so a save without a known version is refused while it does. `seenWhileSaving` holds
 * the versions the tree showed while a save was in flight, checked once it settles.
 *
 * @example
 * ```ts
 * const status = statusOfBuffer(buffer);
 * ```
 */
export interface EditBuffer {
  path: string;
  text: string;
  autosaver: Autosaver;
  knownVersions: Set<number>;
  seenWhileSaving: Set<number | undefined>;
  remote: 'conflict' | 'deleted' | undefined;
  stillOnTheServer: boolean;
  /** Set once the buffer is dropped or Take theirs starts: no save may write its text any more. */
  retired: boolean;
  state: EditBufferState | undefined;
}

/**
 * What the conflict choices need from the buffers they act on.
 *
 * @example
 * ```ts
 * const buffer = host.find('notes.md');
 * ```
 */
export interface EditBufferHost {
  session: EditBufferSession;
  /** The buffer at `path` now, or `undefined`. */
  find: (path: string) => EditBuffer | undefined;
  /** Publishes the buffer's new state. */
  refresh: (buffer: EditBuffer) => void;
  /** Ends the buffer and forgets its edits. */
  drop: (buffer: EditBuffer) => void;
  /** Resolves once no `followMove` in flight covers the buffer's path, so writes go to its final path. */
  settled: (buffer: EditBuffer) => Promise<void>;
}

/**
 * The status a buffer shows: what happened on the server (`conflict`, `deleted`) before its autosaver's.
 *
 * @example
 * ```ts
 * const dirty = hasUnsavedEdits(statusOfBuffer(buffer));
 * ```
 */
export function statusOfBuffer(buffer: EditBuffer): SaveStatusKind {
  return buffer.remote ?? buffer.autosaver.status().kind;
}
