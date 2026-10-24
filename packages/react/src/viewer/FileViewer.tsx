'use client';
import { basename, type Entry, type FsError } from '@workspacekit/core';
import {
  createElement,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Components } from '../components';
import { partProps } from '../cx';
import { ConflictBanner } from '../editing/ConflictBanner';
import type { SaveStatusKind } from '../editing/autosaver';
import { SaveStatus } from '../editing/SaveStatus';
import { useViewerEditing, type ViewerEditing } from '../editing/useViewerEditing';
import type { ClassNames } from '../parts';
import { focusIsInsideOrNowhere } from '../tree/rovingFocus';
import { UnsupportedViewer } from '../renderers/unsupported/UnsupportedViewer';
import { forgetFailedLoad, lazyRendererComponent } from './lazyRenderer';
import { RendererBoundary } from './RendererBoundary';
import type { Renderer, RendererProps, RendererSource, ViewerError } from './registry';
import {
  useFileViewerAndViewedFile,
  type FileViewerState,
  type UseFileViewerOptions,
  type ViewedFile,
} from './useFileViewer';
import { ViewerHeader } from './ViewerHeader';
import { ViewerErrorView, ViewerLoading } from './ViewerStates';

/**
 * The save state of the text a `FileViewer` edits, for a custom header: render it with `SaveStatus`.
 * `retry` saves again (offered while `status` is `error`).
 *
 * @example
 * ```tsx
 * const header = (state: FileViewerState, save: ViewerSaveState) => (
 *   <SaveStatus status={save.status} onRetry={save.retry} />
 * );
 * ```
 */
export interface ViewerSaveState {
  status: SaveStatusKind;
  error: FsError | undefined;
  retry: () => void;
}

/**
 * Props of `FileViewer`: the `useFileViewer` options plus the shell's.
 *
 * @example
 * ```tsx
 * const props: FileViewerProps = { path: 'README.md', renderers: lightRenderers, onOpenEntry: tabs.open };
 * ```
 */
export interface FileViewerProps extends UseFileViewerOptions {
  path: string;
  /** Default `true`. */
  showHeader?: boolean;
  /**
   * Replaces the default header. The second argument is the save state of the edited text, which the
   * default header shows; render it with `SaveStatus` to keep it.
   */
  renderHeader?: (state: FileViewerState, save: ViewerSaveState) => ReactNode;
  /** Opens an entry a renderer links to, such as a directory listing's row. */
  onOpenEntry?: (path: string) => void;
  className?: string;
  classNames?: ClassNames;
  components?: Pick<Components, 'Loader'>;
}

interface ViewerBodyProps extends Pick<FileViewerProps, 'onOpenEntry' | 'classNames' | 'components'> {
  state: FileViewerState;
  viewedFile: ViewedFile;
  editing: ViewerEditing;
  isActive: boolean;
  focusBody: () => void;
  onErrorAfterAnUpdate: (error: ViewerError) => void;
  onRendererErrorShown: (shown: boolean) => void;
}

function RendererFromRegistry(props: RendererProps & { renderer: Renderer }): React.JSX.Element {
  const { renderer, ...rendererProps } = props;
  return createElement(lazyRendererComponent(renderer), rendererProps);
}

function ReportsShown(props: {
  version: number | undefined;
  onShown: (version: number | undefined) => void;
}): null {
  const { version, onShown } = props;
  useLayoutEffect(() => onShown(version), [version, onShown]);
  return null;
}

interface ShownFileProps extends ViewerBodyProps {
  entry: Entry;
  renderer: Renderer;
  source: RendererSource;
  loading: ReactNode;
}

function ShownFile(props: ShownFileProps): React.JSX.Element {
  const { state, viewedFile, editing, entry, renderer, source, loading, isActive, onOpenEntry, classNames } =
    props;
  return (
    <RendererBoundary
      key={`${state.mode ?? ''}:${viewedFile.identity ?? ''}:${editing.rendererGeneration}`}
      resetKey={state.version}
      onReset={() => forgetFailedLoad(renderer)}
      onErrorAfterAnUpdate={props.onErrorAfterAnUpdate}
      onShowingErrorChange={props.onRendererErrorShown}
      renderError={(error, resetBoundary) => (
        <ViewerErrorView
          error={error}
          onRetry={() => {
            props.focusBody();
            resetBoundary();
          }}
          onDownload={state.download}
          classNames={classNames}
        />
      )}
    >
      {(reportRendererError, noteShown) => (
        <Suspense fallback={loading}>
          <ReportsShown version={state.version} onShown={noteShown} />
          <RendererFromRegistry
            renderer={renderer}
            entry={entry}
            source={editing.source ?? source}
            version={state.version}
            mode={state.mode}
            isActive={isActive}
            readOnly={!editing.editable}
            onChange={editing.onChange}
            onOpenEntry={onOpenEntry}
            onError={reportRendererError}
            onDownload={state.download}
            classNames={classNames}
          />
        </Suspense>
      )}
    </RendererBoundary>
  );
}

function ViewerBody(props: ViewerBodyProps): React.JSX.Element {
  const { state, components, classNames, focusBody } = props;
  const fileName = state.entry?.name ?? basename(state.path);
  const loading = <ViewerLoading fileName={fileName} Loader={components?.Loader} classNames={classNames} />;
  if (state.status === 'loading') return loading;
  if (state.error && state.status === 'error') {
    return (
      <ViewerErrorView
        error={state.error}
        onRetry={() => {
          focusBody();
          state.retry();
        }}
        onDownload={state.download}
        classNames={classNames}
      />
    );
  }
  const { entry, renderer, source } = state;
  if (!entry || !renderer || !source) {
    return (
      <UnsupportedViewer
        fileName={fileName}
        size={entry?.size}
        onDownload={state.download}
        classNames={classNames}
      />
    );
  }
  return <ShownFile {...props} entry={entry} renderer={renderer} source={source} loading={loading} />;
}

interface ShownError {
  path: string;
  version: number | undefined;
  error: ViewerError;
}

function ErrorBanner(props: {
  error: ViewerError;
  onRetry: () => void;
  classNames: ClassNames | undefined;
}): React.JSX.Element {
  const { error, onRetry, classNames } = props;
  return (
    <div role="alert" {...partProps('viewer-banner', classNames)}>
      <p {...partProps('viewer-message', classNames)}>{error.message}</p>
      {error.kind === 'load_error' && (
        <button type="button" {...partProps('viewer-button', classNames)} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

interface ViewerBannersProps {
  state: FileViewerState;
  editing: ViewerEditing;
  errorAfterAnUpdate: ShownError | undefined;
  onRetryRenderer: () => void;
  focusBody: () => void;
  classNames: ClassNames | undefined;
}

function ViewerBanners(props: ViewerBannersProps): React.JSX.Element {
  const { state, editing, errorAfterAnUpdate, onRetryRenderer, focusBody, classNames } = props;
  const refreshError = state.status === 'ready' ? state.error : undefined;
  const rendererError =
    errorAfterAnUpdate?.path === state.path && errorAfterAnUpdate.version === state.version
      ? errorAfterAnUpdate.error
      : undefined;
  const error = refreshError ?? rendererError;
  return (
    <>
      {error && (
        <ErrorBanner
          error={error}
          onRetry={() => {
            focusBody();
            if (refreshError) state.retry();
            else onRetryRenderer();
          }}
          classNames={classNames}
        />
      )}
      <ConflictBanner
        status={editing.status}
        fileName={state.entry?.name ?? basename(state.path)}
        choices={editing}
        classNames={classNames}
      />
    </>
  );
}

function ViewerBodyRegion(props: {
  bodyRef: RefObject<HTMLDivElement | null>;
  state: FileViewerState;
  classNames: ClassNames | undefined;
  children: (onRendererErrorShown: (shown: boolean) => void) => ReactNode;
}): React.JSX.Element {
  const { bodyRef, state, classNames, children } = props;
  const [rendererErrorShown, setRendererErrorShown] = useState(false);
  const showsAnErrorView = state.status === 'error' || rendererErrorShown;
  return (
    <div
      ref={bodyRef}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- an error view may hold nothing focusable, so like a tab panel it is a tab stop itself
      tabIndex={showsAnErrorView ? 0 : -1}
      aria-busy={state.refreshing || undefined}
      data-pending={state.refreshing ? '' : undefined}
      {...partProps('viewer-body', classNames)}
    >
      {children(setRendererErrorShown)}
    </div>
  );
}

function DefaultHeader(props: {
  state: FileViewerState;
  editing: ViewerEditing;
  classNames: ClassNames | undefined;
}): React.JSX.Element {
  const { state, editing, classNames } = props;
  const saveStatus = (editing.editable || editing.status !== 'idle') && (
    <SaveStatus status={editing.status} onRetry={editing.saveNow} classNames={classNames} />
  );
  return <ViewerHeader state={state} saveStatus={saveStatus} classNames={classNames} />;
}

interface ViewerElements {
  root: RefObject<HTMLDivElement | null>;
  body: RefObject<HTMLDivElement | null>;
}

function useFocusAfterResolving(
  focusRequest: number,
  editing: ViewerEditing,
  isActive: boolean,
  elements: ViewerElements,
): void {
  const handledRequest = useRef(0);
  const { awaitingTheirs, rendererGeneration } = editing;
  useEffect(() => {
    if (focusRequest === handledRequest.current || awaitingTheirs) return;
    handledRequest.current = focusRequest;
    const body = elements.body.current;
    if (!isActive || !body || !focusIsInsideOrNowhere(elements.root.current)) return;
    const editor = body.querySelector<HTMLElement>('[data-fs-part=text-editor]:not([readonly])');
    (editor ?? body).focus();
  }, [focusRequest, awaitingTheirs, rendererGeneration, isActive, elements]);
}

/**
 * The file viewer: `useFileViewer` in a styled shell. It shows a header (the file name, a mode toggle when
 * the renderer has more than one mode, the save status, Download when possible), then the renderer
 * `renderers` picks for `path`, loaded on first use: a `role="status"` loader shows while the file or the
 * renderer's code loads, and a `role="alert"` explains an error (with Retry for `load_error`, Download when
 * possible). A renderer that throws, or whose code fails to load, is contained and shows `load_error` until
 * Retry or a new version of the file. Once a renderer has shown the file, a failed refresh, or an error the
 * renderer reports for a newer version, is a `role="alert"` banner (the `viewer-banner` part) above the
 * content instead, and the content stays. Every Retry moves focus to the viewer body, so it does not fall
 * to the page; the body (the `viewer-body` part) is a tab stop while it shows an error view, and is
 * `aria-busy` with `data-pending` while a newer version loads behind the one shown. The root (the `viewer`
 * part) carries `data-mode` and `data-status` (`loading` or `error`).
 *
 * Editing: when the adapter can `write` and the renderer is `editable` (text, and HTML in its source mode),
 * edits go to the provider's edit buffer for the path and autosave a second after typing pauses, with
 * `expectedMtimeMs`. The header's save status reads "Unsaved", "Saving…", "Saved", "Couldn't save. Retry",
 * "Changed by someone else" or "Deleted"; only "Saved" and "Couldn't save." are announced (see
 * `SaveStatus`). When someone else changes the file while it has unsaved edits, a `role="alert"` banner
 * (the `save-banner` part) offers Keep mine (save over theirs), Take theirs (drop the edits and show their
 * version, read-only from the click until it shows) and Save mine as a copy (a free `… copy` name next to
 * the file, opened with `onOpenEntry`, or in the provider's tabs). When the file is deleted, the edits stay
 * on screen and the banner offers Save (create it again) and Discard. After a choice, or Retry, focus goes
 * to the editor (the viewer body when there is none) rather than falling to the page. Without `write`,
 * text is read-only. A custom `renderHeader` gets the save state as its second argument; render it with
 * the exported `SaveStatus` to keep it on screen.
 *
 * A rename or move the viewer follows keeps the renderer mounted (the editor keeps its focus and selection);
 * the renderer starts over only for another file, another mode, or after Take theirs.
 *
 * @example
 * ```tsx
 * <FileViewer path="README.md" renderers={lightRenderers} onOpenEntry={(path) => tabs.open(path)} />
 * ```
 */
export function FileViewer(props: FileViewerProps): React.JSX.Element {
  const { path, showHeader, renderHeader, onOpenEntry, className, classNames, components, ...options } =
    props;
  const [state, viewedFile] = useFileViewerAndViewedFile(path, options);
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const focusBody = (): void => body.current?.focus();
  const [focusRequest, requestFocus] = useState(0);
  const editing = useViewerEditing(state, {
    filePath: viewedFile.currentPath,
    onOpenEntry,
    onSettled: () => requestFocus((request) => request + 1),
  });
  useFocusAfterResolving(focusRequest, editing, options.isActive ?? true, { root, body });
  const [errorAfterAnUpdate, setErrorAfterAnUpdate] = useState<ShownError>();
  const header = renderHeader ? (
    renderHeader(state, { status: editing.status, error: editing.error, retry: editing.saveNow })
  ) : (
    <DefaultHeader state={state} editing={editing} classNames={classNames} />
  );
  return (
    <div
      ref={root}
      {...partProps('viewer', classNames, className)}
      data-mode={state.mode}
      data-status={state.status === 'ready' ? undefined : state.status}
    >
      {(showHeader ?? true) && header}
      <ViewerBanners
        state={state}
        editing={editing}
        errorAfterAnUpdate={errorAfterAnUpdate}
        onRetryRenderer={() => {
          setErrorAfterAnUpdate(undefined);
          editing.remountRenderer();
        }}
        focusBody={focusBody}
        classNames={classNames}
      />
      <ViewerBodyRegion bodyRef={body} state={state} classNames={classNames}>
        {(onRendererErrorShown) => (
          <ViewerBody
            onRendererErrorShown={onRendererErrorShown}
            state={state}
            viewedFile={viewedFile}
            editing={editing}
            focusBody={focusBody}
            onErrorAfterAnUpdate={(error) => setErrorAfterAnUpdate({ path, version: state.version, error })}
            isActive={options.isActive ?? true}
            onOpenEntry={onOpenEntry}
            classNames={classNames}
            components={components}
          />
        )}
      </ViewerBodyRegion>
    </div>
  );
}
