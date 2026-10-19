'use client';
import { captureDataTransfer } from '@scope/core';
import { useId, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import type { Action, CanPerform } from '../actions/actions';
import { createTreeCommandsHost, TreeCommandsContext } from '../actions/treeCommands';
import type { Components } from '../components';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { FileSystemProvider, type FileSystemProviderProps } from '../provider/FileSystemProvider';
import { useFileSystem } from '../provider/hooks';
import { FileSearch } from '../search/FileSearch';
import { FileTabs } from '../tabs/FileTabs';
import { useTabs } from '../tabs/useTabs';
import { FileTree } from '../tree/FileTree';
import { UploadStatus } from '../uploads/UploadStatus';
import { useUploads } from '../uploads/uploads';
import { SplitPane } from './SplitPane';
import { Toolbar } from './Toolbar';
import { useElementWidth } from './useElementWidth';
import { useFollow } from './useFollow';
import { ViewerPlaceholder } from './ViewerPlaceholder';

/**
 * Props of `Workspace`: the provider's props plus the shell's.
 *
 * @example
 * ```tsx
 * const props: WorkspaceProps = {
 *   adapter,
 *   storageKey: 'my-app',
 *   theme: 'dark',
 *   renderViewer: (path) => <Viewer path={path} />,
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
  /** Renders the active tab's file; without it, a placeholder says the file has no viewer yet. */
  renderViewer?: (path: string) => ReactNode;
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
}

const STACKED_BELOW_PX = 640;
const TREE_VIEWPORT = '[data-fs-part=tree-viewport]';

function useFollowState(props: WorkspaceProps): [boolean, (follow: boolean) => void] {
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

function WorkspaceShell(props: WorkspaceProps): React.JSX.Element {
  const { className, classNames, style, theme, renderViewer, actions, canPerform, components, storageKey } =
    props;
  const tabs = useTabs();
  const [follow, setFollow] = useFollowState(props);
  useFollow(follow);
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const stacked = width > 0 && width < STACKED_BELOW_PX;
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [treeCommands] = useState(createTreeCommandsHost);
  const filesId = useId();
  const drop = useDropIntoTheRoot();
  const active = tabs.active;
  return (
    <TreeCommandsContext value={treeCommands}>
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
            <div
              id={filesId}
              {...partProps('workspace-files', classNames)}
              hidden={stacked && filesCollapsed}
            >
              {(props.showSearch ?? true) && (
                <FileSearch classNames={classNames} onOpenFile={(entry) => tabs.open(entry.path)} />
              )}
              <FileTree
                classNames={classNames}
                actions={actions}
                canPerform={canPerform}
                components={components}
                onOpenFile={(entry, how) => tabs.open(entry.path, how)}
              />
              <UploadStatus classNames={classNames} />
            </div>
          </>
          <>
            <FileTabs classNames={classNames} components={components} />
            <div {...partProps('workspace-viewer', classNames)}>
              {active === null ? (
                <ViewerPlaceholder classNames={classNames} />
              ) : (
                (renderViewer?.(active) ?? <ViewerPlaceholder path={active} classNames={classNames} />)
              )}
            </div>
          </>
        </SplitPane>
        {drop.showOverlay && (
          <div {...partProps('drop-overlay', classNames)} aria-hidden="true">
            Drop files to upload them here
          </div>
        )}
      </div>
    </TreeCommandsContext>
  );
}

/**
 * The drop-in file workspace: a `FileSystemProvider` around a toolbar, the search box and the file tree on
 * one side of a resizable split, and the open-file tabs with the active file's viewer on the other. A click
 * on a file previews it in a tab, a double click or Enter pins it; `renderViewer` renders the active file.
 * The split's width is persisted under `storageKey` with the provider's other UI state.
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
 * <Workspace
 *   adapter={httpAdapter('/api/fs')}
 *   storageKey={`my-app:${workspaceId}`}
 *   style={{ height: '100vh' }}
 *   renderViewer={(path) => <MyViewer path={path} />}
 * />
 * ```
 */
export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { adapter, root, fetchDepth, storageKey, hidden, onNotify, onError, onUploadConflict } = props;
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
      <WorkspaceShell {...props} />
    </FileSystemProvider>
  );
}
