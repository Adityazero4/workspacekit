import type { Entry } from '@workspacekit/core';

/**
 * One upload placeholder row: a top-level item of a running upload, shown under its target folder.
 *
 * @example
 * ```ts
 * const placeholder: PlaceholderRow = {
 *   key: '/upload-1/photos',
 *   name: 'photos',
 *   depth: 1,
 *   percent: 40,
 *   target: docs,
 * };
 * ```
 */
export interface PlaceholderRow {
  key: string;
  name: string;
  depth: number;
  percent: number;
  /** The target folder's entry (`null` for the root), so a drag over the placeholder targets that folder. */
  target: Entry | null;
}

/**
 * Placeholder rows inserted right after the row at `afterRowIndex` (-1 inserts them before the first row).
 *
 * @example
 * ```ts
 * const group: PlaceholderGroup = { afterRowIndex: 2, rows: [placeholder] };
 * ```
 */
export interface PlaceholderGroup {
  afterRowIndex: number;
  rows: readonly PlaceholderRow[];
}

/**
 * What sits at one position of the rendered list: a tree row (by its index in the visible-row index) or a
 * placeholder.
 *
 * @example
 * ```ts
 * const slot: LayoutSlot = { kind: 'row', rowIndex: 3 };
 * ```
 */
export type LayoutSlot =
  { kind: 'row'; rowIndex: number } | { kind: 'placeholder'; placeholder: PlaceholderRow };

/**
 * The rendered list: the tree's visible rows with placeholder rows inserted. The virtualizer counts positions
 * in this list; the tree, its keyboard model and its ids keep using row indexes, so placeholders never become
 * tree items.
 *
 * @example
 * ```ts
 * const layout = createRowLayout(tree.index.count, groups);
 * const slot = layout.slotAt(virtualItem.index);
 * ```
 */
export interface RowLayout {
  count: number;
  slotAt: (position: number) => LayoutSlot;
  /** The position of the row at `rowIndex`. */
  positionOf: (rowIndex: number) => number;
  /** The row at `position`, or for a placeholder the row after it (which can be `rowCount`). */
  rowIndexAtOrAfter: (position: number) => number;
}

/**
 * Lays out `rowCount` rows with `groups` of placeholders inserted. Each conversion costs one step per group,
 * so it stays cheap for the few uploads that run at once.
 *
 * @example
 * ```ts
 * createRowLayout(5, [{ afterRowIndex: 2, rows: [placeholder] }]).positionOf(3); // 4
 * ```
 */
export function createRowLayout(rowCount: number, groups: readonly PlaceholderGroup[]): RowLayout {
  const sorted = [...groups].sort((a, b) => a.afterRowIndex - b.afterRowIndex);
  const placeholderCount = sorted.reduce((sum, group) => sum + group.rows.length, 0);
  const slotAt = (position: number): LayoutSlot => {
    let insertedBefore = 0;
    for (const group of sorted) {
      const groupStart = group.afterRowIndex + 1 + insertedBefore;
      if (position < groupStart) break;
      if (position < groupStart + group.rows.length) {
        return { kind: 'placeholder', placeholder: group.rows[position - groupStart]! };
      }
      insertedBefore += group.rows.length;
    }
    return { kind: 'row', rowIndex: position - insertedBefore };
  };
  return {
    count: rowCount + placeholderCount,
    slotAt,
    positionOf: (rowIndex) =>
      sorted.reduce(
        (position, group) => (group.afterRowIndex < rowIndex ? position + group.rows.length : position),
        rowIndex,
      ),
    rowIndexAtOrAfter: (position) => {
      const slot = slotAt(position);
      if (slot.kind === 'row') return slot.rowIndex;
      const group = sorted.find((candidate) => candidate.rows.includes(slot.placeholder))!;
      return group.afterRowIndex + 1;
    },
  };
}
