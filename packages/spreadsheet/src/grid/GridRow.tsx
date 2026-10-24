'use client';
import { partProps } from '@workspacekit/react/renderer-kit';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import type { SheetClassNames } from '../parts';
import type { DrawnCell } from './merges';
import { columnName, gridFontPoints, type GridCell, type GridModel } from './model';
import { dragColumnEdge } from './resize';
import { presentCell, type CellPresentation } from './spill';
import type { GridGeometry } from './useGridVirtualizers';

/**
 * What every row of one grid shares: the model, its geometry, the consumer's class names, the grid's font
 * (once it is known, for measuring text) and the column resizing actions.
 *
 * @example
 * ```ts
 * const frame: GridFrame = { model, geometry, classNames: undefined, font: undefined, columns };
 * // columns: { resize, fit, mountedSignal }
 * ```
 */
export interface GridFrame {
  model: GridModel;
  geometry: GridGeometry;
  classNames: SheetClassNames | undefined;
  font: { family: string; size: string } | undefined;
  columns: {
    resize: (col: number, width: number | ((current: number) => number)) => void;
    fit: (col: number) => void;
    mountedSignal: () => AbortSignal | undefined;
  };
}

const HEADER_ROW_COUNT = 1;
const ROW_HEADER_COLUMN_COUNT = 1;

/**
 * The `aria-rowindex` of a sheet row and the `aria-colindex` of a sheet column: 1-based, after the
 * column-letter row and the row-number column.
 *
 * @example
 * ```ts
 * ariaIndexOf(0, 'row'); // 2
 * ```
 */
export const ariaIndexOf = (index: number, axis: 'row' | 'col'): number =>
  index + 1 + (axis === 'row' ? HEADER_ROW_COUNT : ROW_HEADER_COLUMN_COUNT);

const totalWidthOf = ({ model, geometry }: GridFrame): number =>
  geometry.rowHeaderWidth + geometry.colOffsets[model.colCount]!;

function workbookFormatting(cell: GridCell | undefined): CSSProperties | undefined {
  if (!cell) return undefined;
  const style = cell.style;
  const fontPoints = gridFontPoints(style?.fontSize);
  const decorations = [style?.underline && 'underline', style?.strike && 'line-through'].filter(Boolean);
  return {
    textAlign: cell.align ?? (cell.isNumber ? 'right' : undefined),
    fontWeight: style?.bold ? 'bold' : undefined,
    fontStyle: style?.italic ? 'italic' : undefined,
    textDecorationLine: decorations.length > 0 ? decorations.join(' ') : undefined,
    color: style?.color,
    background: style?.fill,
    fontSize: fontPoints === undefined ? undefined : `${fontPoints}pt`,
    whiteSpace: cell.wrap === 'wrap' ? 'pre-wrap' : undefined,
    overflowWrap: cell.wrap === 'wrap' ? 'anywhere' : undefined,
  };
}

const clippedAtFreeze = (last: number, first: number, frozenCount: number): number =>
  first < frozenCount ? Math.min(last, frozenCount - 1) : last;

function cellBox(
  frame: GridFrame,
  row: number,
  drawn: DrawnCell,
  left: number,
  spillWidth: number | undefined,
): CSSProperties {
  const { rowOffsets, colOffsets } = frame.geometry;
  const { frozen } = frame.model;
  const merge = drawn.merge;
  const lastCol = merge ? clippedAtFreeze(merge.right, drawn.col, frozen.cols) : drawn.col;
  const box: CSSProperties = {
    left,
    width: spillWidth ?? colOffsets[lastCol + 1]! - colOffsets[drawn.col]!,
  };
  if (merge) box.height = rowOffsets[clippedAtFreeze(merge.bottom, row, frozen.rows) + 1]! - rowOffsets[row]!;
  if (spillWidth !== undefined) box.zIndex = 1;
  return box;
}

function presentationOf(
  frame: GridFrame,
  row: number,
  drawn: DrawnCell,
  cell: GridCell | undefined,
): CellPresentation {
  if (!cell || !frame.font || drawn.merge) return { text: cell?.text ?? '' };
  return presentCell(frame.model, row, drawn.col, cell, frame.font);
}

function SheetCell(props: {
  frame: GridFrame;
  row: number;
  drawn: DrawnCell;
  left: number;
  isActive: boolean;
}): React.JSX.Element {
  'use no memo';
  const { frame, row, drawn, isActive } = props;
  const cell = frame.model.cell(row, drawn.col);
  const merge = drawn.merge;
  const shown = presentationOf(frame, row, drawn, cell);
  return (
    <div
      role="gridcell"
      aria-colindex={ariaIndexOf(drawn.col, 'col')}
      aria-rowspan={merge && merge.bottom - merge.top + 1}
      aria-colspan={merge && merge.right - merge.left + 1}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-selected={isActive || undefined}
      {...partProps('sheet-cell', frame.classNames)}
      style={{ ...workbookFormatting(cell), ...cellBox(frame, row, drawn, props.left, shown.spillWidth) }}
    >
      {shown.text}
    </div>
  );
}

function RowShell(props: {
  frame: GridFrame;
  ariaRowIndex: number;
  top: number | undefined;
  height: number;
  start: ReactNode;
  frozen: ReactNode;
  scrolled: ReactNode;
}): React.JSX.Element {
  'use no memo';
  const { frame } = props;
  const frozenWidth = frame.geometry.colOffsets[frame.model.frozen.cols]!;
  return (
    <div
      role="row"
      aria-rowindex={props.ariaRowIndex}
      {...partProps('sheet-row', frame.classNames)}
      style={{ top: props.top, height: props.height, width: totalWidthOf(frame) }}
    >
      {props.start}
      {frozenWidth > 0 && (
        <div
          {...partProps('sheet-frozen', frame.classNames)}
          style={{ left: frame.geometry.rowHeaderWidth, width: frozenWidth }}
        >
          {props.frozen}
        </div>
      )}
      {props.scrolled}
    </div>
  );
}

/**
 * The sticky row of column letters, with the corner above the row numbers.
 *
 * @example
 * ```tsx
 * <ColumnHeaderRow frame={frame} cols={[0, 1, 2]} />
 * ```
 */
export function ColumnHeaderRow(props: { frame: GridFrame; cols: readonly number[] }): React.JSX.Element {
  'use no memo';
  const { frame } = props;
  const { model, geometry, classNames } = frame;
  const header = (col: number, left: number): React.JSX.Element => (
    <div
      key={col}
      role="columnheader"
      aria-colindex={ariaIndexOf(col, 'col')}
      {...partProps('sheet-column-header', classNames)}
      style={{ left, width: model.colWidth(col) }}
    >
      {model.colLabel?.(col) ?? columnName(col)}
      <div
        aria-hidden
        {...partProps('sheet-column-resizer', classNames)}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          const signal = frame.columns.mountedSignal();
          if (signal) {
            dragColumnEdge(event, model.colWidth(col), (width) => frame.columns.resize(col, width), signal);
          }
        }}
        onDoubleClick={() => frame.columns.fit(col)}
      />
    </div>
  );
  const isFrozen = (col: number): boolean => col < model.frozen.cols;
  return (
    <RowShell
      frame={frame}
      ariaRowIndex={HEADER_ROW_COUNT}
      top={undefined}
      height={geometry.headerHeight}
      start={<div {...partProps('sheet-corner', classNames)} style={{ width: geometry.rowHeaderWidth }} />}
      frozen={props.cols.filter(isFrozen).map((col) => header(col, geometry.colOffsets[col]!))}
      scrolled={props.cols
        .filter((col) => !isFrozen(col))
        .map((col) => header(col, geometry.rowHeaderWidth + geometry.colOffsets[col]!))}
    />
  );
}

/**
 * One sheet row: its row number, then its drawn cells. Frozen rows sit in the sticky head and pass no
 * `top`; scrolled rows are placed at `top`.
 *
 * @example
 * ```tsx
 * <SheetRow frame={frame} row={4} cells={[{ col: 0 }]} activeCol={undefined} top={120} />
 * ```
 */
export function SheetRow(props: {
  frame: GridFrame;
  row: number;
  cells: readonly DrawnCell[];
  activeCol: number | undefined;
  top: number | undefined;
}): React.JSX.Element {
  'use no memo';
  const { frame, row } = props;
  const { model, geometry, classNames } = frame;
  const isFrozen = (drawn: DrawnCell): boolean => drawn.col < model.frozen.cols;
  const cell = (drawn: DrawnCell, left: number): React.JSX.Element => (
    <SheetCell
      key={drawn.col}
      frame={frame}
      row={row}
      drawn={drawn}
      left={left}
      isActive={drawn.col === props.activeCol}
    />
  );
  return (
    <RowShell
      frame={frame}
      ariaRowIndex={ariaIndexOf(row, 'row')}
      top={props.top}
      height={model.rowHeight(row)}
      start={
        <div
          role="rowheader"
          {...partProps('sheet-row-header', classNames)}
          style={{ width: geometry.rowHeaderWidth }}
        >
          {model.rowLabel?.(row) ?? String(row + 1)}
        </div>
      }
      frozen={props.cells.filter(isFrozen).map((drawn) => cell(drawn, geometry.colOffsets[drawn.col]!))}
      scrolled={props.cells
        .filter((drawn) => !isFrozen(drawn))
        .map((drawn) => cell(drawn, geometry.rowHeaderWidth + geometry.colOffsets[drawn.col]!))}
    />
  );
}
