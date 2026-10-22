'use client';
import { basename, toFsError, type Entry, type FileSystemAdapter } from '@scope/core';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { downloadEntry, downloadUrl } from '../actions/download';
import { failureMessage, useFileSystem, type FileSystemContext } from '../provider/hooks';
import { hasUnsavedEdits } from '../editing/autosaver';
import type { EditBuffers } from '../editing/buffers';
import type { EditBufferState } from '../editing/editBuffer';
import { useFileSystemInternals } from '../provider/internals';
import {
  resolveRenderer,
  viewerError,
  type Renderer,
  type RendererSource,
  type ViewerError,
} from './registry';
import {
  adapterUrlOf,
  adapterUrlSource,
  shownAt,
  SourceLoader,
  type ShownSource,
  type SourceLoaderState,
  type SourceRequest,
} from './sources';
import { useViewerEntry, type EntryLookup } from './useViewerEntry';
import { withViewMode } from './viewModes';

/**
 * Where a viewer is: loading the file, showing it (`ready`), or unable to show it (`error`).
 *
 * @example
 * ```ts
 * const busy = (status: FileViewerStatus): boolean => status === 'loading';
 * ```
 */
export type FileViewerStatus = 'loading' | 'ready' | 'error';

/**
 * What `useFileViewer` returns for one path.
 *
 * @example
 * ```tsx
 * const { status, renderer, source }: FileViewerState = useFileViewer(path, { renderers });
 * ```
 */
export interface FileViewerState {
  path: string;
  entry: Entry | undefined;
  renderer: Renderer | undefined;
  status: FileViewerStatus;
  source: RendererSource | undefined;
  /** The `mtimeMs` of the version `source` holds; it changes together with `source`. */
  version: number | undefined;
  error: ViewerError | undefined;
  /** A newer version is loading while `source` still shows the previous one. */
  refreshing: boolean;
  mode: string | undefined;
  modes: readonly { value: string; label: string }[];
  setMode: (mode: string) => void;
  retry: () => void;
  /** Saves the file through `adapter.download`, or its `adapter.url`; `undefined` when neither exists. */
  download: (() => void) | undefined;
}

/**
 * Options of `useFileViewer`.
 *
 * @example
 * ```ts
 * const options: UseFileViewerOptions = { renderers: lightRenderers, isActive: tab.path === active };
 * ```
 */
export interface UseFileViewerOptions {
  renderers: readonly Renderer[];
  /**
   * Default true. While false, nothing is read: a file not shown yet stays `loading`, and a shown one keeps
   * its version. Becoming active catches up.
   */
  isActive?: boolean;
  /** Controls the view mode; leave it out to keep the mode per path in the provider. */
  mode?: string;
  /** The mode an uncontrolled viewer starts in, when the renderer offers it (default: its first mode). */
  defaultMode?: string;
  onModeChange?: (mode: string) => void;
}

type ViewMode = Pick<FileViewerState, 'mode' | 'modes' | 'setMode'>;

const NO_MODES: FileViewerState['modes'] = [];

function useViewMode(path: string, renderer: Renderer | undefined, options: UseFileViewerOptions): ViewMode {
  const { viewModes } = useFileSystemInternals();
  const readPicked = (): string | undefined => viewModes.get().get(path);
  const picked = useSyncExternalStore(viewModes.subscribe, readPicked, readPicked);
  const modes = renderer?.modes ?? NO_MODES;
  const offered = (mode: string | undefined): string | undefined =>
    modes.some((option) => option.value === mode) ? mode : undefined;
  const setMode = (mode: string): void => {
    if (options.mode === undefined) viewModes.set((all) => withViewMode(all, path, mode));
    options.onModeChange?.(mode);
  };
  return {
    mode: options.mode ?? offered(picked) ?? offered(options.defaultMode) ?? modes[0]?.value,
    modes,
    setMode,
  };
}

function useSourceLoader(): [SourceLoader, SourceLoaderState] {
  const { onMovedPaths } = useFileSystemInternals();
  const [loader] = useState(() => new SourceLoader());
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  useEffect(() => onMovedPaths(loader.followMove), [onMovedPaths, loader]);
  useEffect(() => loader.dispose, [loader]);
  return [loader, state];
}

function downloadOf(fs: FileSystemContext, entry: Entry | undefined): (() => void) | undefined {
  if (!entry) return undefined;
  const { adapter } = fs;
  const reportFailure = (error: unknown): void => {
    const fsError = toFsError(error);
    fs.notify({
      kind: 'error',
      message: failureMessage(`Download failed for "${entry.name}"`, fsError),
      error: fsError,
    });
  };
  if (adapter.download) return () => void downloadEntry(adapter, entry).catch(reportFailure);
  if (!adapter.url || entry.kind !== 'file') return undefined;
  return () => {
    try {
      const answer = adapterUrlOf(adapter, entry);
      if (answer) downloadUrl(answer.url, entry.name);
    } catch (error) {
      reportFailure(error);
    }
  };
}

const streamsFromAdapterUrl = (adapter: FileSystemAdapter, entry: Entry, renderer: Renderer): boolean =>
  renderer.input === 'url' && adapterUrlSource(adapter, entry) !== undefined;

const isTooLarge = (adapter: FileSystemAdapter, entry: Entry, renderer: Renderer): boolean =>
  renderer.maxBytes !== undefined &&
  !streamsFromAdapterUrl(adapter, entry, renderer) &&
  typeof entry.size === 'number' &&
  entry.size > renderer.maxBytes;

function useUnsavedEdits(editBuffers: EditBuffers, path: string): EditBufferState | undefined {
  const read = (): EditBufferState | undefined => {
    const buffer = editBuffers.get(path);
    return buffer && hasUnsavedEdits(buffer.status) ? buffer : undefined;
  };
  return useSyncExternalStore(editBuffers.subscribe, read, read);
}

function onlyInTheEditBuffer(
  path: string,
  unsaved: EditBufferState | undefined,
  lookup: EntryLookup,
): Entry | undefined {
  const missing = lookup.error?.kind === 'not_found' || lookup.error?.kind === 'deleted';
  return unsaved && missing ? { path, name: basename(path), kind: 'file' } : undefined;
}

function requestFor(
  adapter: FileSystemAdapter,
  entry: Entry,
  renderer: Renderer,
  paused: boolean,
): SourceRequest {
  return {
    adapter,
    entry,
    input: renderer.input,
    paused,
    maxBytes: streamsFromAdapterUrl(adapter, entry, renderer) ? undefined : renderer.maxBytes,
  };
}

function statusFor(
  entry: Entry | undefined,
  error: ViewerError | undefined,
  renderer: Renderer | undefined,
  shown: ShownSource | undefined,
): FileViewerStatus {
  if (shown) return 'ready';
  if (error) return 'error';
  return entry && !renderer ? 'ready' : 'loading';
}

/**
 * The headless file viewer: finds the entry at `path`, picks its renderer from `renderers`, and loads the
 * content in the shape the renderer asks for (`RendererInput`).
 *
 * - **Entry:** read from the tree when its folder is loaded (re-rendering only when this entry or that
 *   folder's status changes), otherwise with one `adapter.stat`, or one load of the folder when the adapter
 *   has no `stat` (`retry` asks again). A missing entry is `not_found`, or `deleted` when it, or its content,
 *   was shown since `path` last changed.
 * - **Size gate:** a file over the renderer's `maxBytes` is `too_large` and never read; a text file with
 *   unsaved edits is not gated, so its editor stays when the file grows past the limit. A `url` input that
 *   streams from a URL `adapter.url` gave has no gate. When the entry has no `size` there is no gate before
 *   reading; the bytes read are checked instead (text by its UTF-8 bytes), and an over-limit read is
 *   `too_large`.
 * - **Sources:** `url` comes from `adapter.url` when it gives an http, https or blob URL, and otherwise from
 *   a blob read into a URL that cannot render as a page (a `data:` URL for SVG, an object URL otherwise);
 *   `text`, `blob` and `arrayBuffer` are read; `none` reads nothing. Every read gets an `AbortSignal` and
 *   is aborted when the path or version changes, or on unmount. An object URL is revoked once a render
 *   without it is committed, and on unmount.
 * - **Versions:** `version` is the entry's `mtimeMs`. A new version loads while the old source stays, with
 *   `refreshing: true`; `source` and `version` change together. A failed refresh keeps the old source and
 *   sets `error` (`retry` tries again). While `isActive` is false, or a text file has unsaved edits, the
 *   source shown is not refreshed; a viewer that was never active reads nothing and stays `loading`. A file
 *   deleted while its text has unsaved edits stays `ready` with the source shown, so the edits stay on
 *   screen until they are saved (recreating the file) or discarded; a path whose file exists only as unsaved
 *   edits (never shown here, such as the copy a replacing move set aside) is `ready` with those edits as its
 *   text source.
 * - **Moves:** when the file moves (through `followMove`, or any move the store reports) and `path` follows
 *   it, before or after the move commits, the source stays on screen, also while a `followMove` is in flight
 *   and the new path is not listed yet. It is reused as is (object
 *   URL included) when the version and size did not change, and reloaded otherwise.
 * - **Modes:** the renderer's first mode by default, kept per path in the provider unless `mode` controls it.
 *
 * `status` is `ready` while a source is shown, even with a refresh `error`.
 *
 * @example
 * ```tsx
 * const viewer = useFileViewer(path, { renderers: lightRenderers });
 * if (viewer.status === 'error') return <p role="alert">{viewer.error?.message}</p>;
 * ```
 */
export function useFileViewer(path: string, options: UseFileViewerOptions): FileViewerState {
  return useFileViewerAndViewedFile(path, options)[0];
}

/**
 * Which file a viewer shows, beyond its path: `identity` changes only when another file is shown in its
 * place (a move, a rename or a new version keeps it; `undefined` while nothing is loaded), and `currentPath`
 * is where that file is now, ahead of `path` while a move the viewer will follow is reported but `path` has
 * not changed yet.
 *
 * @internal
 * @example
 * ```ts
 * const [state, { identity, currentPath }] = useFileViewerAndViewedFile(path, { renderers });
 * ```
 */
export interface ViewedFile {
  identity: number | undefined;
  currentPath: string;
}

/**
 * `useFileViewer`, plus the `ViewedFile` the shell keys its renderer on and edits at.
 *
 * @internal
 * @example
 * ```ts
 * const [state, viewedFile] = useFileViewerAndViewedFile(path, { renderers: lightRenderers });
 * ```
 */
export function useFileViewerAndViewedFile(
  path: string,
  options: UseFileViewerOptions,
): [FileViewerState, ViewedFile] {
  const fs = useFileSystem();
  const { editBuffers } = useFileSystemInternals();
  const [attempt, setAttempt] = useState(0);
  const [loader, { shown: loaded, loading, failure }] = useSourceLoader();
  const shownHere = shownAt(loaded, path);
  const unsaved = useUnsavedEdits(editBuffers, path);
  const dirty = unsaved !== undefined;
  const lookup = useViewerEntry(path, attempt, shownHere, dirty);
  const unsavedFile = onlyInTheEditBuffer(path, unsaved, lookup);
  const entry = lookup.entry ?? unsavedFile;
  const entryError = unsavedFile ? undefined : lookup.error;
  const renderer = entry ? resolveRenderer(entry, options.renderers) : undefined;
  const editsPauseTheSource = renderer?.input === 'text' && dirty;
  const gated = entry && renderer && !editsPauseTheSource && isTooLarge(fs.adapter, entry, renderer);
  const fileError = entryError ?? (gated ? viewerError('too_large') : undefined);
  const paused = options.isActive === false || editsPauseTheSource;
  const request =
    entry && renderer && !fileError ? requestFor(fs.adapter, entry, renderer, paused) : undefined;
  useEffect(() => loader.sync(path, request));
  const shown = !fileError && shownHere?.input === renderer?.input ? shownHere : undefined;
  const objectUrlOnScreen = shown?.objectUrl;
  useLayoutEffect(() => loader.showing(objectUrlOnScreen), [loader, objectUrlOnScreen]);
  const viewMode = useViewMode(path, renderer, options);
  const error = fileError ?? (failure?.path === path ? failure.error : undefined);
  const movedTo = loaded?.path === path ? loaded.movedTo : undefined;
  const viewedFile = { identity: shown?.identity, currentPath: movedTo ?? path };
  const state: FileViewerState = {
    path,
    entry,
    renderer,
    status: unsavedFile ? 'ready' : statusFor(entry, error, renderer, shown),
    source: shown?.source ?? (unsavedFile && unsaved ? { kind: 'text', text: unsaved.text } : undefined),
    version: shown?.version,
    error,
    refreshing: shown !== undefined && loading,
    ...viewMode,
    retry: () => {
      loader.retry();
      setAttempt((previous) => previous + 1);
    },
    download: unsavedFile ? undefined : downloadOf(fs, entry),
  };
  return [state, viewedFile];
}
