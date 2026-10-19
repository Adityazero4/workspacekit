'use client';
import type { DroppedItem, Entry, VisibleRowIndex } from '@scope/core';
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem } from '@tanstack/react-virtual';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from 'react';
import type { Action, CanPerform } from '../actions/actions';
import { TreeActionOverlays } from '../actions/TreeActionOverlays';
import { useAttachedTreeCommands } from '../actions/treeCommands';
import { useTreeActions } from '../actions/useTreeActions';
import type { Components } from '../components';
import { partProps } from '../cx';
import { useIsRootDropTarget, useTreeDnd } from '../dnd/useTreeDnd';
import type { ClassNames } from '../parts';
import { useEntryState, useFileSystem, type FileSystemContext } from '../provider/hooks';
import { UploadPlaceholderRow } from '../uploads/UploadPlaceholderRow';
import { useUploads } from '../uploads/uploads';
import { useUploadInputs } from '../uploads/useUploadInputs';
import { uploadPlaceholderGroups } from '../uploads/placeholders';
import { createRowLayout, type RowLayout } from './rowLayout';
import { rowsCoveredAbove, stickyAncestors, stickyCapacity, StickyHeaders } from './StickyHeaders';
import { focusFellToBody } from './rovingFocus';
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

const OVERSCAN = 10;
const ROWS_IN_FIRST_PAINT = 50;

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
  const {
    className,
    classNames,
    style,
    renderIcon,
    renderBadge,
    renderTrailing,
    emptyState,
    onOpenFile,
    components,
  } = props;
  const fs = useFileSystem();
  const rootStatus = useEntryState(fs.root).status;
  const openFile = (entry: Entry, how: 'preview' | 'pin'): void => {
    fs.store.markSeen(entry.path);
    onOpenFile?.(entry, how);
  };
  const { tree, inlineRename, flashing } = useFileTreeWithInlineRename({
    rowHeight: props.rowHeight,
    onOpenFile: openFile,
  });
  const uploads = useUploads();
  const startUpload = (items: DroppedItem[], targetDir: string): void => {
    if (targetDir !== fs.root) tree.expand(targetDir);
    void uploads.upload(items, targetDir);
  };
  const uploadInputs = useUploadInputs({
    enabled: fs.adapter.upload !== undefined,
    onPicked: startUpload,
    classNames,
  });
  const dnd = useTreeDnd({ fs, tree, startUpload });
  const isRootDropTarget = useIsRootDropTarget(dnd.handlers.dropTarget);
  const layout = createRowLayout(
    tree.index.count,
    uploadPlaceholderGroups(uploads.runs, tree.index, fs.root),
  );
  const viewport = useRef<HTMLDivElement>(null);
  const rowWindow = useRowWindow(tree, layout, viewport);
  const stickyRows =
    (props.stickyHeaders ?? true) ? stickyCapacity(rowWindow.viewportHeight, tree.rowHeight) : 0;
  const headers = stickyAncestors(
    tree.index,
    layout.rowIndexAtOrAfter(rowWindow.firstVisibleIndex),
    stickyRows,
  );
  useEffect(() =>
    tree.setScrollToIndex((rowIndex) =>
      scrollRowIntoView(viewport.current, rowIndex, { ...tree, layout }, stickyRows),
    ),
  );
  useSelectionMarksSeen(fs);
  const emptyStateRef = useEmptyStateThatPassesFocusBackToTheRows(tree);
  const treeActions = useTreeActions(tree, {
    actions: props.actions,
    canPerform: props.canPerform,
    pickUploads: uploadInputs.pick,
  });
  useAttachedTreeCommands(
    {
      canRun: (actionId, entry) => treeActions.visibleFor(entry).some((action) => action.id === actionId),
      runAction: treeActions.runFromOutside,
      collapseAll: tree.collapseAll,
    },
    { adapter: fs.adapter, actions: props.actions, canPerform: props.canPerform },
  );

  const { toggle, rowBindings } = tree;
  const shared: TreeRowShared = {
    classNames,
    renderIcon,
    renderBadge,
    renderTrailing,
    bindings: rowBindings,
    openFile,
    openMenu: treeActions.openMenu,
    inlineRename,
    flashing,
    draggable: fs.adapter.move !== undefined || fs.adapter.copy !== undefined,
    drag: dnd.handlers,
    activate: (entry, clickCount) => {
      fs.selected.set(entry.path);
      fs.store.markSeen(entry.path);
      if (entry.kind === 'file') openFile(entry, 'preview');
      else if (clickCount <= 1) toggle(entry.path);
    },
  };
  const isEmpty = layout.count === 0 && rootStatus === 'loaded';
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
      {headers.length > 0 && (
        <StickyHeaders
          rows={headers}
          classNames={classNames}
          renderIcon={renderIcon}
          onActivate={(path) => tree.focus(path)}
          onOpenMenu={treeActions.openMenu}
          drag={dnd.handlers}
        />
      )}
      {isEmpty ? (
        <div key="empty" {...partProps('tree-empty', classNames)} tabIndex={-1} ref={emptyStateRef}>
          {EmptyState ? <EmptyState>{emptyState}</EmptyState> : emptyState}
        </div>
      ) : (
        <div
          key="tree"
          {...treeProps}
          {...partProps('tree', classNames)}
          aria-label={props['aria-label'] ?? 'Files'}
          style={{ height: rowWindow.totalSize }}
        >
          <TreeRowContext value={shared}>
            {rowWindow.items.map((item) => {
              const slot = layout.slotAt(item.index);
              if (slot.kind === 'placeholder') {
                return (
                  <UploadPlaceholderRow
                    key={slot.placeholder.key}
                    placeholder={slot.placeholder}
                    offset={item.start}
                    drag={dnd.handlers}
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
      {uploadInputs.inputs}
    </div>
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

interface RowWindow {
  items: VirtualItem[];
  totalSize: number;
  firstVisibleIndex: number;
  viewportHeight: number;
}

function useRowWindow(
  tree: FileTreeApi,
  layout: RowLayout,
  viewport: RefObject<HTMLElement | null>,
): RowWindow {
  'use no memo';
  const { rowHeight } = tree;
  const renamingIndex = tree.renaming === null ? -1 : tree.index.indexOf(tree.renaming);
  const positionOfRow = (rowIndex: number): number => (rowIndex < 0 ? -1 : layout.positionOf(rowIndex));
  const rangeExtractor = useRangeExtractorStableUntilAKeptRowMoves(
    positionOfRow(tree.tabbableIndex),
    positionOfRow(renamingIndex),
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this hook uncompiled; it returns fresh values every render
  const virtualizer = useVirtualizer({
    count: layout.count,
    getScrollElement: () => viewport.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: (ROWS_IN_FIRST_PAINT - OVERSCAN) * rowHeight },
    rangeExtractor,
  });
  return {
    items: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    firstVisibleIndex: virtualizer.range?.startIndex ?? 0,
    viewportHeight: virtualizer.scrollRect?.height ?? 0,
  };
}

interface RangeExtractorKeepingRows {
  tabStopIndex: number;
  renamingIndex: number;
  extract: (range: Range) => number[];
}

function rangeExtractorKeeping(tabStopIndex: number, renamingIndex: number): RangeExtractorKeepingRows {
  return {
    tabStopIndex,
    renamingIndex,
    extract: (range) => withRowsKeptRendered(defaultRangeExtractor(range), [tabStopIndex, renamingIndex]),
  };
}

function useRangeExtractorStableUntilAKeptRowMoves(
  tabStopIndex: number,
  renamingIndex: number,
): (range: Range) => number[] {
  const [current, setCurrent] = useState(() => rangeExtractorKeeping(tabStopIndex, renamingIndex));
  const keepsTheSameRows = current.tabStopIndex === tabStopIndex && current.renamingIndex === renamingIndex;
  if (keepsTheSameRows) return current.extract;
  const next = rangeExtractorKeeping(tabStopIndex, renamingIndex);
  setCurrent(next);
  return next.extract;
}

function withRowsKeptRendered(rowIndexes: number[], keptRowIndexes: number[]): number[] {
  const missing = keptRowIndexes.filter((kept) => kept >= 0 && !rowIndexes.includes(kept));
  if (missing.length === 0) return rowIndexes;
  return [...new Set([...rowIndexes, ...missing])].sort((a, b) => a - b);
}

function scrollRowIntoView(
  viewport: HTMLElement | null,
  rowIndex: number,
  tree: Pick<FileTreeApi, 'index' | 'rowHeight'> & { layout: RowLayout },
  stickyRows: number,
): void {
  if (!viewport) return;
  const { index, rowHeight, layout } = tree;
  const position = layout.positionOf(rowIndex);
  const rowTop = position * rowHeight;
  const coveredNow = stickyRowsAt(index, layout, viewport.scrollTop, rowHeight, stickyRows) * rowHeight;
  if (rowTop < viewport.scrollTop + coveredNow) {
    viewport.scrollTop = (position - rowsCoveredAbove(index, rowIndex, stickyRows)) * rowHeight;
  } else if (rowTop + rowHeight > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = rowTop + rowHeight - viewport.clientHeight;
  }
}

function stickyRowsAt(
  index: VisibleRowIndex,
  layout: RowLayout,
  scrollTop: number,
  rowHeight: number,
  stickyRows: number,
): number {
  const firstRowInView = layout.rowIndexAtOrAfter(Math.floor(scrollTop / rowHeight));
  return stickyAncestors(index, firstRowInView, stickyRows).length;
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
