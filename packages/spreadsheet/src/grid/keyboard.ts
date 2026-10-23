import { anchorOf, mergeAt } from './merges';
import type { CellAddress, GridModel } from './model';

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/**
 * The cell a navigation key moves the focus to, or `undefined` for any other key. Arrow keys step off the
 * edge of a merged range, Home and End go to the ends of the row, and with Ctrl (or ⌘) to the first and
 * last cells of the sheet; PageUp and PageDown move `pageRows` rows. A cell inside a merged range resolves
 * to the range's anchor. The grid selects one cell at a time, so Shift with an arrow is a plain move, not
 * a range selection.
 *
 * @example
 * ```ts
 * cellAfterKey({ key: 'End', ctrlKey: true, metaKey: false }, { row: 0, col: 0 }, model, 20);
 * // { row: model.rowCount - 1, col: model.colCount - 1 }
 * ```
 */
export function cellAfterKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean },
  active: CellAddress,
  model: GridModel,
  pageRows: number,
): CellAddress | undefined {
  const lastRow = model.rowCount - 1;
  const lastCol = model.colCount - 1;
  const toTheCorner = event.ctrlKey || event.metaKey;
  const span = mergeAt(model.merges, active.row, active.col) ?? {
    top: active.row,
    left: active.col,
    bottom: active.row,
    right: active.col,
  };
  const target = ((): CellAddress | undefined => {
    switch (event.key) {
      case 'ArrowRight':
        return { row: active.row, col: span.right + 1 };
      case 'ArrowLeft':
        return { row: active.row, col: span.left - 1 };
      case 'ArrowDown':
        return { row: span.bottom + 1, col: active.col };
      case 'ArrowUp':
        return { row: span.top - 1, col: active.col };
      case 'PageDown':
        return { row: span.bottom + pageRows, col: active.col };
      case 'PageUp':
        return { row: span.top - pageRows, col: active.col };
      case 'Home':
        return toTheCorner ? { row: 0, col: 0 } : { row: active.row, col: 0 };
      case 'End':
        return toTheCorner ? { row: lastRow, col: lastCol } : { row: active.row, col: lastCol };
      default:
        return undefined;
    }
  })();
  return (
    target && anchorOf(model.merges, { row: clamp(target.row, lastRow), col: clamp(target.col, lastCol) })
  );
}
