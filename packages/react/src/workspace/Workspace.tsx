'use client';
import { captureDataTransfer } from '@scope/core';
import {
  memo,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { Action, CanPerform } from '../actions/actions';
import type { Components } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { FileSystemProvider, type FileSystemProviderProps } from '../provider/FileSystemProvider';
import { useFileSystem } from '../provider/hooks';
import { useFileSystemInternals } from '../provider/internals';
import { FileSearch } from '../search/FileSearch';
import { FileTabs, type TabPanelIds } from '../tabs/FileTabs';
import { useTabs, type TabsApi } from '../tabs/useTabs';
import { FileTree } from '../tree/FileTree';
import { UploadStatus } from '../uploads/UploadStatus';
import { useUploads } from '../uploads/uploads';
import { FileViewer } from '../viewer/FileViewer';
import { lightRenderers } from '../viewer/lightRenderers';
import type { Renderer } from '../viewer/registry';
import { SplitPane } from './SplitPane';
import { Toolbar } from './Toolbar';
import { useElementWidth } from './useElementWidth';
import { useFollow } from './useFollow';
import { useWorkspace, type WorkspaceController } from './useWorkspace';

/**
 * Props of `Workspace`: the provider's props plus the shell's.
 *
 * @example
 * ```tsx
 * const props: WorkspaceProps = {
 *   adapter,
 *   storageKey: 'my-app',
 *   theme: 'dark',
 *   renderers: [markdownRenderer, ...lightRenderers],
 * };
 * ```
 */
export interface WorkspaceProps extends Omit<FileSystemProviderProps, 'children'> {
  /** Class of the root element (the `workspace` part). */
  className?: string;
  classNames?: ClassNames;
  /** Style of the root element; give it a height. */
  style?: CSSProperties;
  /** Sets `data-theme` on the root; `'system'` (the default) follows `prefers-color-scheme`. */
  theme?: 'light' | 'dark' | 'system';
  /**
   * Renders one open tab's file; default: a `FileViewer` with `renderers`. Every open tab stays mounted,
   * hidden while in the background, with `isActive` false.
   */
  renderViewer?: (path: string, isActive: boolean) => ReactNode;
  /** The viewers' renderers, used by the default `renderViewer`. Default `lightRenderers`. */
  renderers?: readonly Renderer[];
  /** Extra tree actions, after the built-in ones the adapter supports. */
  actions?: Action[];
  /** Policy: return `false` to hide an action for an entry, in the tree's menus and in the toolbar. */
  canPerform?: CanPerform;
  /** Replace the default (Radix) menu and dialog, or wrap the tree's empty state. */
  components?: Components;
  /** Default `true`. */
  showSearch?: boolean;
  /** Default `true`. */
  showToolbar?: boolean;
  /** Makes follow mode controlled; toggles are reported through `onFollowChange`. */
  follow?: boolean;
  /** Follow mode at mount when uncontrolled. Default `false`. */
  defaultFollow?: boolean;
  onFollowChange?: (follow: boolean) => void;
  /** Receives the same controller `useWorkspace` returns, to drive the workspace from outside it. */
  ref?: Ref<WorkspaceController>;
}

const STACKED_BELOW_PX = 640;
const TREE_VIEWPORT = '[data-fs-part=tree-viewport]';

function useFollowState(
  props: Pick<WorkspaceProps, 'follow' | 'defaultFollow' | 'onFollowChange'>,
): [boolean, (follow: boolean) => void] {
  const [uncontrolledFollow, setUncontrolledFollow] = useState(props.defaultFollow ?? false);
  const isControlled = props.follow !== undefined;
  const setFollow = (follow: boolean): void => {
    if (!isControlled) setUncontrolledFollow(follow);
    props.onFollowChange?.(follow);
  };
  return [props.follow ?? uncontrolledFollow, setFollow];
}

const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files');
const isOverATree = (event: DragEvent): boolean =>
  event.target instanceof Element && event.target.closest(TREE_VIEWPORT) !== null;

function useDropIntoTheRoot(): {
  showOverlay: boolean;
  handlers: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDropCapture: () => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
} {
  const fs = useFileSystem();
  const uploads = useUploads();
  const [showOverlay, setShowOverlay] = useState(false);
  const accepts = (event: DragEvent): boolean => fs.adapter.upload !== undefined && carriesFiles(event);
  return {
    showOverlay,
    handlers: {
      onDragEnter: (event) => {
        if (isOverATree(event)) setShowOverlay(false);
      },
      onDragOver: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setShowOverlay(true);
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowOverlay(false);
      },
      onDropCapture: () => setShowOverlay(false),
      onDrop: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        void uploads.upload(captureDataTransfer(event.dataTransfer), fs.root);
      },
    },
  };
}

interface FilesPaneProps extends Pick<
  WorkspaceProps,
  'classNames' | 'actions' | 'canPerform' | 'components'
> {
  stacked: boolean;
  showSearch: boolean;
  openTab: TabsApi['open'];
}

function FilesPane(props: FilesPaneProps): React.JSX.Element {
  const { stacked, showSearch, openTab, classNames, actions, canPerform, components } = props;
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const filesId = useId();
  return (
    <>
      {stacked && (
        <button
          type="button"
          {...partProps('workspace-files-toggle', classNames)}
          aria-expanded={!filesCollapsed}
          aria-controls={filesId}
          onClick={() => setFilesCollapsed((collapsed) => !collapsed)}
        >
          Files
        </button>
      )}
      <div id={filesId} {...partProps('workspace-files', classNames)} hidden={stacked && filesCollapsed}>
        {showSearch && <FileSearch classNames={classNames} onOpenFile={(entry) => openTab(entry.path)} />}
        <FileTree
          classNames={classNames}
          actions={actions}
          canPerform={canPerform}
          components={components}
          onOpenFile={(entry, how) => openTab(entry.path, how)}
        />
        <UploadStatus classNames={classNames} />
      </div>
    </>
  );
}

interface ViewerPaneProps extends Pick<
  WorkspaceProps,
  'classNames' | 'components' | 'renderViewer' | 'renderers'
> {
  openTab: TabsApi['open'];
}

interface ViewerTabProps extends Pick<WorkspaceProps, 'classNames'>, TabPanelIds {
  path: string;
  isActive: boolean;
  renderViewer: NonNullable<WorkspaceProps['renderViewer']>;
}

const ViewerTab = memo(function ViewerTab(props: ViewerTabProps): React.JSX.Element {
  const { path, isActive, tabId, panelId, renderViewer, classNames } = props;
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={!isActive}
      {...partProps('workspace-viewer-tab', classNames)}
    >
      {renderViewer(path, isActive)}
    </div>
  );
});

function useTabPanelIds(): (path: string) => TabPanelIds {
  const idPrefix = useId();
  const { tabIds } = useFileSystemInternals();
  return (path) => {
    const id = tabIds.idOf(path);
    return { tabId: `${idPrefix}tab-${id}`, panelId: `${idPrefix}panel-${id}` };
  };
}

function ViewerPane(props: ViewerPaneProps): React.JSX.Element {
  const { openTab, classNames, components } = props;
  const { tabs, active } = useTabs();
  const tabPanelIds = useTabPanelIds();
  const renderers = props.renderers ?? lightRenderers;
  const renderViewer =
    props.renderViewer ??
    ((path: string, isActive: boolean) => (
      <FileViewer
        path={path}
        isActive={isActive}
        renderers={renderers}
        onOpenEntry={(entryPath) => openTab(entryPath, 'preview')}
        classNames={classNames}
        components={components}
      />
    ));
  return (
    <>
      <FileTabs classNames={classNames} components={components} tabPanelIds={tabPanelIds} />
      <div {...partProps('workspace-viewer', classNames)}>
        {active === null && <p {...partProps('viewer-placeholder', classNames)}>Select a file to open it.</p>}
        {tabs.map(({ path }) => {
          const ids = tabPanelIds(path);
          return (
            <ViewerTab
              key={ids.panelId}
              path={path}
              isActive={path === active}
              tabId={ids.tabId}
              panelId={ids.panelId}
              renderViewer={renderViewer}
              classNames={classNames}
            />
          );
        })}
      </div>
    </>
  );
}

interface WorkspaceShellProps extends Omit<WorkspaceProps, 'ref'> {
  controllerRef: WorkspaceProps['ref'];
}

function WorkspaceShell(props: WorkspaceShellProps): React.JSX.Element {
  const { className, classNames, style, theme, actions, canPerform, components, storageKey } = props;
  const workspace = useWorkspace();
  useImperativeHandle(props.controllerRef, () => workspace, [workspace]);
  const [follow, setFollow] = useFollowState(props);
  useFollow(follow);
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const stacked = width > 0 && width < STACKED_BELOW_PX;
  const { treeCommands } = useFileSystemInternals();
  const drop = useDropIntoTheRoot();
  return (
    <div
      ref={root}
      {...partProps('workspace', classNames, className)}
      style={style}
      data-theme={theme === 'light' || theme === 'dark' ? theme : undefined}
      {...drop.handlers}
    >
      {(props.showToolbar ?? true) && (
        <Toolbar
          classNames={classNames}
          treeCommands={treeCommands}
          follow={follow}
          onFollowChange={setFollow}
        />
      )}
      <SplitPane storageKey={storageKey} stacked={stacked} classNames={classNames}>
        <FilesPane
          stacked={stacked}
          showSearch={props.showSearch ?? true}
          openTab={workspace.open}
          classNames={classNames}
          actions={actions}
          canPerform={canPerform}
          components={components}
        />
        <ViewerPane
          openTab={workspace.open}
          renderViewer={props.renderViewer}
          renderers={props.renderers}
          classNames={classNames}
          components={components}
        />
      </SplitPane>
      {drop.showOverlay && (
        <div {...partProps('drop-overlay', classNames)} aria-hidden="true">
          Drop files to upload them here
        </div>
      )}
    </div>
  );
}

/**
 * The drop-in file workspace: a `FileSystemProvider` around a toolbar, the search box and the file tree on
 * one side of a resizable split, and the open-file tabs with the active file's viewer on the other. A click
 * on a file previews it in a tab, a double click or Enter pins it. Each open tab gets a `FileViewer` (with
 * `renderers`) or `renderViewer`'s output; background tabs stay mounted, hidden and with `isActive` false,
 * and closing a tab unmounts its viewer. A directory viewer's row opens in a preview tab. Components inside
 * drive the workspace with `useWorkspace`, and code outside it through `ref`. The split's width is
 * persisted under `storageKey` with the provider's other UI state.
 *
 * When the workspace itself (not the window: it is often embedded in a sidebar) is narrower than 640 px, the
 * panes stack and a Files toggle button (`aria-expanded`) collapses the tree pane. Files dropped onto the
 * workspace outside the tree upload into the store root, through the same upload path as the tree; an overlay
 * marks the drop zone meanwhile.
 *
 * Follow mode (the toolbar's Follow button; `follow` / `defaultFollow`, off by default) reveals each file
 * someone else (an agent) changes, at most once per 500 ms with the latest change winning: it expands the
 * folders above it, selects it, scrolls it into view, flashes it and opens it as a preview tab, but never
 * moves focus. Because it moves the selection, it also moves the target of the toolbar's New file, New folder
 * and Upload files. A change is followed again when the agent touches the same file again; a reveal the user
 * started (from search) is never replaced, and follow waits for it. Like `FileTree`, the default menus and
 * dialogs render in place (see `Components`), so `theme` reaches them.
 *
 * @example
 * ```tsx
 * const [adapter] = useState(() => httpAdapter('/api/fs'));
 * const workspace = useRef<WorkspaceController>(null);
 * <Workspace
 *   ref={workspace}
 *   adapter={adapter}
 *   storageKey={`my-app:${workspaceId}`}
 *   style={{ height: '100vh' }}
 *   renderers={[markdownRenderer, ...lightRenderers]}
 * />
 * <button onClick={() => workspace.current?.open('README.md', 'pin')}>Open the README</button>
 * ```
 */
export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { ref, ...shellProps } = props;
  const { adapter, root, fetchDepth, storageKey, hidden, onNotify, onError, onUploadConflict } = shellProps;
  return (
    <FileSystemProvider
      adapter={adapter}
      root={root}
      fetchDepth={fetchDepth}
      storageKey={storageKey}
      hidden={hidden}
      onNotify={onNotify}
      onError={onError}
      onUploadConflict={onUploadConflict}
    >
      <WorkspaceShell {...shellProps} controllerRef={ref} />
    </FileSystemProvider>
  );
}
