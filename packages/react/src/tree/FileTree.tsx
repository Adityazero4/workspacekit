'use client';
import type { DroppedItem, Entry } from '@scope/core';
import type { VirtualItem } from '@tanstack/react-virtual';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from 'react';
import type { Action, CanPerform } from '../actions/actions';
import { TreeActionOverlays } from '../actions/TreeActionOverlays';
import { useAttachedTreeCommands } from '../actions/treeCommands';
import { useTreeActions, type TreeActions } from '../actions/useTreeActions';
import type { Components } from '../components';
import { partProps } from '../cx';
import {
  useIsRootDropTarget,
  useTreeDnd,
  type TreeDragHandlers,
  type TreeViewportDragProps,
} from '../dnd/useTreeDnd';
import type { ClassNames } from '../parts';
import { useEntryState, useFileSystem, type FileSystemContext } from '../provider/hooks';
import type { UiStore } from '../provider/ui-store';
import { UploadPlaceholderRow } from '../uploads/UploadPlaceholderRow';
import { useUploads, type UploadRun } from '../uploads/uploads';
import { useUploadInputs, type UploadInputs, type UploadPickerKind } from '../uploads/useUploadInputs';
import type { InlineRename } from './inlineRename';
import type { RowLayout } from './rowLayout';
import { useRowsOnScreen, type RowsOnScreen } from './rowsOnScreen';
import { focusFellToBody } from './rovingFocus';
import { StickyHeaders } from './StickyHeaders';
import { TreeRow, TreeRowContext, type TreeRowShared } from './TreeRow';
import {
  useFileTreeWithInlineRename,
  type FileTreeApi,
  type TreeProps,
  type UseFileTreeOptions,
} from './useFileTree';

/**
 * Props of `FileTree`.
 *
 * @example
 * ```tsx
 * const props: FileTreeProps = {
 *   'aria-label': 'Workspace',
 *   onOpenFile: (entry, how) => openTab(entry.path, how),
 * };
 * ```
 */
export interface FileTreeProps extends UseFileTreeOptions {
  /** Class of the root element (the `tree-viewport` part, which scrolls). */
  className?: string;
  classNames?: ClassNames;
  /** Style of the root element; give it a height. */
  style?: CSSProperties;
  /** Default `'Files'`. */
  'aria-label'?: string;
  /** Replaces the default file and folder icons (a loading or failed folder still shows its status icon). */
  renderIcon?: (entry: Entry, state: { expanded: boolean }) => ReactNode;
  renderBadge?: (entry: Entry) => ReactNode;
  renderTrailing?: (entry: Entry) => ReactNode;
  /** Shown instead of the tree once the root has loaded with no visible entries. */
  emptyState?: ReactNode;
  /** Keep the open ancestors of the first visible row stuck to the top. Default `true`. */
  stickyHeaders?: boolean;
  /** Extra actions, after the built-in ones the adapter supports. */
  actions?: Action[];
  /** Policy: return `false` to hide an action for an entry in the menus and from the shortcuts. */
  canPerform?: CanPerform;
  /** Replace the default (Radix) menu and dialog, or wrap the empty state. */
  components?: Components;
}

/**
 * The file tree: a virtualized WAI-ARIA tree over the nearest `FileSystemProvider`, with sticky folder
 * headers, changed/pending/loading/error markers and render slots.
 *
 * A click selects a row, previews a file and toggles a folder; a double click pins a file. Selecting or
 * opening an entry marks it seen. Keyboard focus is never left under the sticky headers; when the focused row
 * is removed, focus moves to the row now at its index, or to the empty state once no rows are left. Rows are
 * memoized, so a change re-renders only the rows it concerns. Give the tree a height; it scrolls itself.
 *
 * Actions are data: the built-in ones the adapter supports plus `actions`, filtered by `when` and
 * `canPerform`, render the same list in the right-click menu, the row's More actions button and Shift+F10 /
 * ContextMenu, and run from their shortcuts. Delete asks first; New file and New folder ask for a validated
 * name, then select the new entry. Focus returns to the row when a menu or dialog closes. F2 or the Rename
 * action edits the name in place; the row being renamed stays rendered while scrolled away. The first mounted
 * tree shows what the provider's `reveal` (used by `FileSearch`) reveals: it scrolls to the row and focuses
 * it (unless the reveal passes `focus: false`), and with `flash` marks it `data-flash` for 1.5 s.
 *
 * Rows drag and drop natively: a drop moves the entry into the folder under the pointer, an Alt (Option) drop
 * copies it, and files dropped from the operating system upload there (as do the Upload files and Upload
 * folder actions, when the adapter can upload). A folder hovered for 400 ms opens. While an upload runs, a
 * `data-pending` placeholder row per top-level item shows its progress under the open target folder (at the
 * top for the root, even while the tree is otherwise empty); placeholders are not tree items. Dragging rows
 * between two trees is not supported.
 *
 * The default menu and dialog render in place (see `Components`): the tree and its ancestors must not set
 * `transform`, `filter`, `contain: paint | layout | strict` or `will-change: transform`; pass portalled
 * `components.Menu` and `components.Dialog` if they do. With `classNames`, style `menu-item-danger` and
 * `dialog-button-danger` alongside `menu-item` and `dialog-button`.
 *
 * @example
 * ```tsx
 * <FileSystemProvider adapter={adapter}>
 *   <FileTree style={{ height: 400 }} onOpenFile={(entry, how) => openTab(entry.path, how)} />
 * </FileSystemProvider>
 * ```
 */
export function FileTree(props: FileTreeProps): React.JSX.Element {
  const { className, classNames, style, renderIcon, emptyState, components } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const { tree, rows, shared, dnd, treeActions, uploads, isRootDropTarget, isEmpty, attachEmptyState } =
    useFileTreeModel(props, viewport);
  const treeProps = withActionKeys(tree.getTreeProps(), treeActions.onKeyDown);
  const EmptyState = components?.EmptyState;
  return (
    <div
      ref={viewport}
      {...partProps('tree-viewport', classNames, className)}
      {...dnd.viewportProps}
      data-drop-target={isRootDropTarget ? '' : undefined}
      tabIndex={-1}
      style={withRowHeightToken(style, tree.rowHeight)}
    >
      {rows.headers.length > 0 && (
        <StickyHeaders
          rows={rows.headers}
          classNames={classNames}
          renderIcon={renderIcon}
          onActivate={(path) => tree.focus(path)}
          onOpenMenu={treeActions.openMenu}
          drag={dnd.handlers}
        />
      )}
      {isEmpty ? (
        <div key="empty" {...partProps('tree-empty', classNames)} tabIndex={-1} ref={attachEmptyState}>
          {EmptyState ? <EmptyState>{emptyState}</EmptyState> : emptyState}
        </div>
      ) : (
        <div
          key="tree"
          {...treeProps}
          {...partProps('tree', classNames)}
          aria-label={props['aria-label'] ?? 'Files'}
          style={{ height: rows.rowWindow.totalSize }}
        >
          <TreeRowContext value={shared}>
            <OnScreenRows
              items={rows.rowWindow.items}
              layout={rows.layout}
              tree={tree}
              drag={dnd.handlers}
              classNames={classNames}
            />
          </TreeRowContext>
        </div>
      )}
      <TreeActionOverlays
        treeActions={treeActions}
        tree={tree}
        viewport={viewport}
        components={components}
        classNames={classNames}
      />
      {uploads.inputs}
    </div>
  );
}

interface FileTreeModel {
  tree: FileTreeApi;
  rows: RowsOnScreen;
  shared: TreeRowShared;
  dnd: { handlers: TreeDragHandlers; viewportProps: TreeViewportDragProps };
  treeActions: TreeActions;
  uploads: TreeUploads;
  isRootDropTarget: boolean;
  isEmpty: boolean;
  attachEmptyState: RefCallback<HTMLDivElement>;
}

function useFileTreeModel(props: FileTreeProps, viewport: RefObject<HTMLDivElement | null>): FileTreeModel {
  const { classNames, onOpenFile } = props;
  const fs = useFileSystem();
  const rootStatus = useEntryState(fs.root).status;
  const openFile = (entry: Entry, how: 'preview' | 'pin'): void => {
    fs.store.markSeen(entry.path);
    onOpenFile?.(entry, how);
  };
  const rendered = useFileTreeWithInlineRename({ rowHeight: props.rowHeight, onOpenFile: openFile });
  const { tree } = rendered;
  const uploads = useTreeUploads(fs, tree, classNames);
  const dnd = useTreeDnd({ fs, tree, startUpload: uploads.start });
  const isRootDropTarget = useIsRootDropTarget(dnd.handlers.dropTarget);
  const rows = useRowsOnScreen(tree, viewport, {
    uploadRuns: uploads.runs,
    root: fs.root,
    stickyHeaders: props.stickyHeaders ?? true,
  });
  useSelectionMarksSeen(fs);
  const attachEmptyState = useEmptyStateThatPassesFocusBackToTheRows(tree);
  const treeActions = useTreeActionsServingTheToolbar(fs, tree, {
    actions: props.actions,
    canPerform: props.canPerform,
    pickUploads: uploads.pick,
  });
  const shared = useRowContextValue(props, rendered, {
    openFile,
    openMenu: treeActions.openMenu,
    drag: dnd.handlers,
  });
  const isEmpty = rows.layout.count === 0 && rootStatus === 'loaded';
  return { tree, rows, shared, dnd, treeActions, uploads, isRootDropTarget, isEmpty, attachEmptyState };
}

interface TreeUploads extends UploadInputs {
  runs: readonly UploadRun[];
  start: (items: DroppedItem[], targetDir: string) => void;
}

function useTreeUploads(
  fs: FileSystemContext,
  tree: FileTreeApi,
  classNames: ClassNames | undefined,
): TreeUploads {
  const uploads = useUploads();
  const start = (items: DroppedItem[], targetDir: string): void => {
    if (targetDir !== fs.root) tree.expand(targetDir);
    void uploads.upload(items, targetDir);
  };
  const { inputs, pick } = useUploadInputs({
    enabled: fs.adapter.upload !== undefined,
    onPicked: start,
    classNames,
  });
  return { runs: uploads.runs, start, inputs, pick };
}

function useTreeActionsServingTheToolbar(
  fs: FileSystemContext,
  tree: FileTreeApi,
  options: {
    actions?: Action[];
    canPerform?: CanPerform;
    pickUploads: (kind: UploadPickerKind, targetDir: string) => void;
  },
): TreeActions {
  const treeActions = useTreeActions(tree, options);
  useAttachedTreeCommands(
    {
      canRun: (actionId, entry) => treeActions.visibleFor(entry).some((action) => action.id === actionId),
      runAction: treeActions.runFromOutside,
      collapseAll: tree.collapseAll,
      startRename: tree.startRename,
      focus: tree.focus,
    },
    { adapter: fs.adapter, actions: options.actions, canPerform: options.canPerform },
  );
  return treeActions;
}

function useRowContextValue(
  slots: Pick<FileTreeProps, 'classNames' | 'renderIcon' | 'renderBadge' | 'renderTrailing'>,
  rendered: { tree: FileTreeApi; inlineRename: InlineRename; flashing: UiStore<string | null> },
  handlers: Pick<TreeRowShared, 'openFile' | 'openMenu' | 'drag'>,
): TreeRowShared {
  const fs = useFileSystem();
  const { classNames, renderIcon, renderBadge, renderTrailing } = slots;
  const { inlineRename, flashing } = rendered;
  const { toggle, rowBindings } = rendered.tree;
  const { openFile, openMenu, drag } = handlers;
  return {
    classNames,
    renderIcon,
    renderBadge,
    renderTrailing,
    bindings: rowBindings,
    openFile,
    openMenu,
    inlineRename,
    flashing,
    draggable: fs.adapter.move !== undefined || fs.adapter.copy !== undefined,
    drag,
    activate: (entry, clickCount) => {
      fs.selected.set(entry.path);
      fs.store.markSeen(entry.path);
      if (entry.kind === 'file') openFile(entry, 'preview');
      else if (clickCount <= 1) toggle(entry.path);
    },
  };
}

function OnScreenRows(props: {
  items: VirtualItem[];
  layout: RowLayout;
  tree: FileTreeApi;
  drag: TreeDragHandlers;
  classNames?: ClassNames;
}): React.JSX.Element {
  const { items, layout, tree, drag, classNames } = props;
  return (
    <>
      {items.map((item) => {
        const slot = layout.slotAt(item.index);
        if (slot.kind === 'placeholder') {
          return (
            <UploadPlaceholderRow
              key={slot.placeholder.key}
              placeholder={slot.placeholder}
              offset={item.start}
              drag={drag}
              classNames={classNames}
            />
          );
        }
        const row = tree.index.rowAt(slot.rowIndex);
        return (
          <TreeRow
            key={row.path}
            path={row.path}
            rowIndex={slot.rowIndex}
            offset={item.start}
            depth={row.depth}
            setSize={row.setSize}
            posInSet={row.posInSet}
            isTabStop={slot.rowIndex === tree.tabbableIndex}
            isFocused={tree.treeHasFocus && row.path === tree.focusedPath}
          />
        );
      })}
    </>
  );
}

function withActionKeys(treeProps: TreeProps, onActionKey: KeyboardEventHandler): TreeProps {
  return {
    ...treeProps,
    onKeyDown: (event) => {
      treeProps.onKeyDown(event);
      onActionKey(event);
    },
  };
}

function withRowHeightToken(style: CSSProperties | undefined, rowHeight: number): CSSProperties {
  return { ...style, '--fs-row-height': `${rowHeight}px` } as CSSProperties;
}

function useEmptyStateThatPassesFocusBackToTheRows(tree: FileTreeApi): RefCallback<HTMLDivElement> {
  const emptyStateHeldFocusWhenRemoved = useRef(false);
  useLayoutEffect(() => {
    if (!emptyStateHeldFocusWhenRemoved.current || tree.tabbableIndex < 0) return;
    emptyStateHeldFocusWhenRemoved.current = false;
    if (focusFellToBody()) tree.focus(tree.index.rowAt(tree.tabbableIndex).path);
  });
  return (element) => {
    if (!element) return;
    emptyStateHeldFocusWhenRemoved.current = false;
    if (tree.treeHasFocus && focusFellToBody()) element.focus();
    return () => {
      emptyStateHeldFocusWhenRemoved.current = element.contains(document.activeElement);
    };
  };
}

function useSelectionMarksSeen({ selected, store }: FileSystemContext): void {
  useEffect(
    () =>
      selected.subscribe(() => {
        const path = selected.get();
        if (path !== null) store.markSeen(path);
      }),
    [selected, store],
  );
}
