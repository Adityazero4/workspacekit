'use client';
import type { Entry, VisibleRow, VisibleRowIndex } from '@workspacekit/core';
import type { MenuAnchor } from '../components';
import { partProps } from '../cx';
import type { TreeDragHandlers } from '../dnd/useTreeDnd';
import { Icons } from '../icons';
import type { FileTreeProps } from './FileTree';

const MAX_STICKY_ROWS = 7;
const MAX_SHARE_OF_VIEWPORT = 0.4;

/**
 * How many sticky header rows fit: at most 7, and at most 40% of the viewport.
 *
 * @example
 * ```ts
 * stickyCapacity(240, 24); // 4
 * ```
 */
export function stickyCapacity(viewportHeight: number, rowHeight: number): number {
  return Math.min(MAX_STICKY_ROWS, Math.floor((viewportHeight * MAX_SHARE_OF_VIEWPORT) / rowHeight));
}

/**
 * The sticky header rows while `firstVisibleIndex` is the first row in view: its open ancestors, the
 * innermost `capacity` of them.
 *
 * @example
 * ```ts
 * const capacity = stickyCapacity(viewportHeight, tree.rowHeight);
 * const headers = stickyAncestors(tree.index, firstVisibleIndex, capacity);
 * ```
 */
export function stickyAncestors(
  index: VisibleRowIndex,
  firstVisibleIndex: number,
  capacity: number,
): readonly VisibleRow[] {
  if (capacity <= 0 || firstVisibleIndex >= index.count) return [];
  return index.ancestorsAt(firstVisibleIndex).slice(-capacity);
}

/**
 * How many rows the sticky headers would cover once `rowIndex` is scrolled to just below them, so that a
 * scroll can leave the row in view instead of under the headers.
 *
 * @example
 * ```ts
 * scroller.scrollTop = (rowIndex - rowsCoveredAbove(index, rowIndex, capacity)) * rowHeight;
 * ```
 */
export function rowsCoveredAbove(index: VisibleRowIndex, rowIndex: number, capacity: number): number {
  let covered = 0;
  for (;;) {
    const needed = stickyAncestors(index, Math.max(0, rowIndex - covered), capacity).length;
    if (needed <= covered) return covered;
    covered = needed;
  }
}

/**
 * Props of `StickyHeaders`.
 *
 * @example
 * ```tsx
 * const props: StickyHeadersProps = {
 *   rows,
 *   onActivate: (path) => tree.focus(path),
 *   onOpenMenu: treeActions.openMenu,
 *   drag: dnd.handlers,
 * };
 * ```
 */
export type StickyHeadersProps = Pick<FileTreeProps, 'classNames' | 'renderIcon'> & {
  rows: readonly VisibleRow[];
  onActivate: (path: string) => void;
  /** Opens the folder's action menu, as a right click on its row does; returns whether it opened. */
  onOpenMenu: (entry: Entry, anchor: MenuAnchor) => boolean;
  /** Dragging over a header targets its folder, as over its row. */
  drag: Pick<TreeDragHandlers, 'dragOver' | 'drop'>;
};

/**
 * The open folders above the first visible row, stuck to the top of the tree. Hidden from assistive
 * technology (the rows themselves carry the structure); a click activates the folder's row, a right click
 * opens its action menu, and a drag over it targets its folder.
 *
 * @example
 * ```tsx
 * <StickyHeaders rows={stickyAncestors(index, first, capacity)} onActivate={(path) => tree.focus(path)}
 *   onOpenMenu={treeActions.openMenu} drag={dnd.handlers} />
 * ```
 */
export function StickyHeaders({
  rows,
  classNames,
  renderIcon,
  onActivate,
  onOpenMenu,
  drag,
}: StickyHeadersProps): React.JSX.Element {
  return (
    <div {...partProps('tree-sticky', classNames)} aria-hidden="true">
      {rows.map((row) => (
        <div
          key={row.path}
          {...partProps('tree-sticky-row', classNames)}
          aria-hidden="true"
          data-expanded=""
          style={{ paddingInlineStart: `calc(${row.depth} * var(--fs-indent))` }}
          onClick={() => onActivate(row.path)}
          onContextMenu={(event) => {
            if (onOpenMenu(row.entry, { x: event.clientX, y: event.clientY })) event.preventDefault();
          }}
          onDragOver={(event) => drag.dragOver(event, row.entry)}
          onDrop={(event) => drag.drop(event, row.entry)}
        >
          <span {...partProps('tree-chevron', classNames)}>
            <Icons.Chevron />
          </span>
          <span {...partProps('tree-row-icon', classNames)}>
            {renderIcon ? renderIcon(row.entry, { expanded: true }) : <Icons.FolderOpen />}
          </span>
          <span {...partProps('tree-row-label', classNames)}>{row.entry.name}</span>
        </div>
      ))}
    </div>
  );
}
