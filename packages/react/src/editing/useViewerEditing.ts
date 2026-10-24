'use client';
import { basename, toFsError, type FsError } from '@workspacekit/core';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { failureMessage, useFileSystem, type FileSystemContext } from '../provider/hooks';
import { useFileSystemInternals } from '../provider/internals';
import { openProviderTab } from '../tabs/useTabs';
import type { RendererSource } from '../viewer/registry';
import type { FileViewerState } from '../viewer/useFileViewer';
import { hasUnsavedEdits, type SaveStatusKind } from './autosaver';
import type { EditBuffers } from './buffers';
import type { ConflictChoices } from './ConflictBanner';
import type { EditBufferState } from './editBuffer';

/**
 * How a `FileViewer` edits its file: whether the renderer may edit, the text to show (the buffer's while it
 * holds edits), the save status, and the conflict choices. `rendererGeneration` changes whenever the
 * renderer must start over, such as once their version has loaded after Take theirs; until then
 * `awaitingTheirs` is true and the file is read-only.
 *
 * @example
 * ```ts
 * const { editable, onChange, status }: ViewerEditing = useViewerEditing(state, {
 *   filePath: state.path,
 *   onSettled: focusEditor,
 * });
 * ```
 */
export interface ViewerEditing extends ConflictChoices {
  status: SaveStatusKind;
  error: FsError | undefined;
  editable: boolean;
  source: RendererSource | undefined;
  onChange: ((text: string) => void) | undefined;
  rendererGeneration: number;
  awaitingTheirs: boolean;
  remountRenderer: () => void;
  saveNow: () => void;
}

/**
 * Options of `useViewerEditing`.
 *
 * @example
 * ```ts
 * const options: ViewerEditingOptions = { filePath: path, onOpenEntry: tabs.open, onSettled: focusEditor };
 * ```
 */
export interface ViewerEditingOptions {
  /**
   * Where the shown file is now (`ViewedFile.currentPath`): ahead of `state.path` while a move the viewer
   * follows is reported but its path has not changed yet. The edit buffer there is the one shown and edited.
   */
  filePath: string;
  /** Opens the copy Save mine as a copy wrote; default: the provider's tabs. */
  onOpenEntry?: (path: string) => void;
  /** Called once a choice (or Retry) has settled, its button being gone. */
  onSettled: () => void;
}

interface AwaitedVersion {
  path: string;
  version: number | undefined;
  resolved: boolean;
}

function useEditBuffer(editBuffers: EditBuffers, path: string): EditBufferState | undefined {
  const read = (): EditBufferState | undefined => editBuffers.get(path);
  return useSyncExternalStore(editBuffers.subscribe, read, read);
}

const showsTheBufferText = (buffer: EditBufferState, version: number | undefined): boolean =>
  hasUnsavedEdits(buffer.status) || (version !== undefined && buffer.knownVersions.has(version));

function reportFailure(fs: FileSystemContext, failure: string): (error: unknown) => void {
  return (error) => {
    const fsError = toFsError(error);
    fs.notify({ kind: 'error', message: failureMessage(failure, fsError), error: fsError });
  };
}

interface ChoiceWiring {
  fs: FileSystemContext;
  editBuffers: EditBuffers;
  path: string;
  awaitTheirs: (awaited: Omit<AwaitedVersion, 'path'> | undefined) => void;
  options: ViewerEditingOptions;
}

function conflictChoices(wiring: ChoiceWiring): ConflictChoices & { saveNow: () => void } {
  const { fs, editBuffers, path, awaitTheirs, options } = wiring;
  const name = basename(path);
  const settle = (work: Promise<unknown>, failure: string): void =>
    void work.catch(reportFailure(fs, failure)).finally(options.onSettled);
  const openCopy = options.onOpenEntry ?? ((copyPath: string) => openProviderTab(fs, copyPath, 'pin'));
  return {
    keepMine: () => settle(editBuffers.keepMine(path), `Couldn't keep your "${name}"`),
    takeTheirs: () => {
      awaitTheirs({ version: undefined, resolved: false });
      const taken = editBuffers.takeTheirs(path).then(
        (version) => awaitTheirs({ version, resolved: true }),
        (error: unknown) => {
          awaitTheirs(undefined);
          throw error;
        },
      );
      settle(taken, `Couldn't take their "${name}"`);
    },
    saveCopy: () =>
      settle(
        editBuffers.saveCopy(path).then((saved) => {
          if (!saved) return;
          if (!saved.editsKept) awaitTheirs({ version: saved.theirVersion, resolved: true });
          openCopy(saved.copyPath);
        }),
        `Couldn't save a copy of "${name}"`,
      ),
    recreate: () => settle(editBuffers.recreate(path), `Couldn't save "${name}"`),
    discard: () => settle(Promise.resolve(editBuffers.discard(path)), `Couldn't discard "${name}"`),
    saveNow: () => settle(editBuffers.flush(path), `Couldn't save "${name}"`),
  };
}

function useRemountOnceTheirVersionShows(
  state: FileViewerState,
): [number, boolean, (awaited: AwaitedVersion | undefined) => void, () => void] {
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [awaited, setAwaited] = useState<AwaitedVersion>();
  const remountRenderer = (): void => setRendererGeneration((generation) => generation + 1);
  const arrived =
    awaited?.resolved === true &&
    (awaited.path !== state.path || awaited.version === undefined || awaited.version === state.version);
  if (arrived) {
    setAwaited(undefined);
    remountRenderer();
  }
  return [rendererGeneration, awaited !== undefined && !arrived, setAwaited, remountRenderer];
}

/**
 * Connects a `FileViewer` to the provider's edit buffers. Text is editable when the adapter can `write`
 * and the renderer is `editable` with a text source; the first edit starts the path's buffer, which
 * autosaves. While the buffer holds unsaved edits, or a version it wrote, the renderer is given the
 * buffer's text, so a remount or a deletion never loses edits; a newer version from someone else replaces
 * it once the buffer is clean. From the click on Take theirs (and once Save mine as a copy has written the
 * copy) the file is read-only until their version has loaded, then the renderer starts over with it. A
 * clean buffer is released when the viewer leaves its path.
 *
 * @example
 * ```tsx
 * const { source, editable, onChange } = useViewerEditing(state, { filePath, onSettled: focusEditor });
 * <Renderer source={source ?? state.source} readOnly={!editable} onChange={onChange} />
 * ```
 */
export function useViewerEditing(state: FileViewerState, options: ViewerEditingOptions): ViewerEditing {
  const fs = useFileSystem();
  const { editBuffers } = useFileSystemInternals();
  const { version } = state;
  const path = options.filePath;
  const buffer = useEditBuffer(editBuffers, path);
  const [rendererGeneration, awaitingTheirs, setAwaited, remountRenderer] =
    useRemountOnceTheirVersionShows(state);
  useEffect(() => () => editBuffers.releaseIfClean(path), [editBuffers, path]);
  const editable =
    !awaitingTheirs &&
    fs.adapter.write !== undefined &&
    state.renderer?.editable === true &&
    state.source?.kind === 'text';
  const awaitTheirs = (awaited: Omit<AwaitedVersion, 'path'> | undefined): void =>
    setAwaited(awaited && { path: state.path, ...awaited });
  return {
    status: buffer?.status ?? 'idle',
    error: buffer?.error,
    editable,
    source: buffer && showsTheBufferText(buffer, version) ? { kind: 'text', text: buffer.text } : undefined,
    onChange: editable ? (text) => editBuffers.edit(path, text, version) : undefined,
    rendererGeneration,
    awaitingTheirs,
    remountRenderer,
    ...conflictChoices({ fs, editBuffers, path, awaitTheirs, options }),
  };
}
