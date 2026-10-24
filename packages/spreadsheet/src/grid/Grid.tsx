'use client';
import { partProps } from '@workspacekit/react/renderer-kit';
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { SheetClassNames } from '../parts';
import { ariaIndexOf, ColumnHeaderRow, SheetRow, type GridFrame } from './GridRow';
import { cellAfterKey } from './keyboard';
import { cellsToDraw } from './merges';
import { gridSize, type CellAddress, type GridModel } from './model';
import { fittedColumnWidth } from './resize';
import { offsetsOf, useGridVirtualizers, type GridGeometry } from './useGridVirtualizers';

const HEADER_HEIGHT = 24;
const ROW_HEADER_MIN_WIDTH = 40;
const ROW_HEADER_WIDTH_PER_DIGIT = 8;
const ROW_HEADER_PADDING = 16;

/**
 * Props of `Grid`. `aria-label` names the grid (the sheet's name). `activeCell` makes the focused cell
 * controlled (the grid scrolls to it when it changes); `onActiveCellChange` hears every move of it, by
 * keyboard or pointer.
 *
 * @example
 * ```tsx
 * const props: GridProps = { model, 'aria-label': 'Sheet1' };
 * ```
 */
export interface GridProps {
  model: GridModel;
  'aria-label': string;
  classNames?: SheetClassNames;
  activeCell?: CellAddress;
  onActiveCellChange?: (cell: CellAddress) => void;
}

type GridFont = { family: string; size: string };

function useGridFont(viewportRef: RefObject<HTMLElement | null>): GridFont | undefined {
  const [font, setFont] = useState<GridFont>();
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const style = getComputedStyle(viewport);
    setFont({ family: style.fontFamily, size: style.fontSize });
  }, [viewportRef]);
  return font;
}

type ColumnWidth = number | ((current: number) => number);

function useColumnWidths(model: GridModel): {
  sized: GridModel;
  resize: (col: number, width: ColumnWidth) => void;
} {
  const [widths, setWidths] = useState<ReadonlyMap<number, number>>(() => new Map());
  const sized =
    widths.size === 0
      ? model
      : { ...model, colWidth: (col: number) => widths.get(col) ?? model.colWidth(col) };
  const resize = (col: number, width: ColumnWidth): void =>
    setWidths((current) => {
      const next =
        typeof width === 'number' ? width : width(gridSize(current.get(col) ?? model.colWidth(col), 'col'));
      return new Map(current).set(col, next);
    });
  return { sized, resize };
}

const KEYBOARD_RESIZE_STEP_PX = 8;

function useMountedSignal(): () => AbortSignal | undefined {
  const controllerRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => controller.abort();
  }, []);
  return () => controllerRef.current?.signal;
}

function geometryOf(model: GridModel): GridGeometry {
  const lastLabel = model.rowLabel?.(model.rowCount - 1) ?? String(model.rowCount);
  return {
    rowOffsets: offsetsOf(model.rowCount, model.rowHeight, 'row'),
    colOffsets: offsetsOf(model.colCount, model.colWidth, 'col'),
    headerHeight: HEADER_HEIGHT,
    rowHeaderWidth: Math.max(
      ROW_HEADER_MIN_WIDTH,
      lastLabel.length * ROW_HEADER_WIDTH_PER_DIGIT + ROW_HEADER_PADDING,
    ),
  };
}

function laidOutModel(model: GridModel, geometry: GridGeometry, frozen: GridModel['frozen']): GridModel {
  const { rowOffsets, colOffsets } = geometry;
  return {
    ...model,
    frozen,
    rowHeight: (row) => rowOffsets[row + 1]! - rowOffsets[row]!,
    colWidth: (col) => colOffsets[col + 1]! - colOffsets[col]!,
  };
}

const withinSheet = (cell: CellAddress, model: GridModel): CellAddress => ({
  row: Math.max(0, Math.min(cell.row, model.rowCount - 1)),
  col: Math.max(0, Math.min(cell.col, model.colCount - 1)),
});

function addressOfCell(element: Element): CellAddress | undefined {
  const cell = element.closest('[role=gridcell]');
  const row = cell?.closest('[role=row]');
  if (!cell || !row) return undefined;
  return {
    row: Number(row.getAttribute('aria-rowindex')) - ariaIndexOf(0, 'row'),
    col: Number(cell.getAttribute('aria-colindex')) - ariaIndexOf(0, 'col'),
  };
}

function focusCell(viewport: HTMLElement | null, cell: CellAddress): void {
  const row = viewport?.querySelector(`[role=row][aria-rowindex="${ariaIndexOf(cell.row, 'row')}"]`);
  row
    ?.querySelector<HTMLElement>(`[aria-colindex="${ariaIndexOf(cell.col, 'col')}"]`)
    ?.focus({ preventScroll: true });
}

function useRovingFocus(
  model: GridModel,
  viewportRef: RefObject<HTMLElement | null>,
  reveal: (cell: CellAddress) => void,
  props: Pick<GridProps, 'activeCell' | 'onActiveCellChange'>,
  pageRows: number,
) {
  const [requested, setActive] = useState<CellAddress>({ row: 0, col: 0 });
  const focusPendingRef = useRef(false);
  const active = withinSheet(props.activeCell ?? requested, model);
  const revealActive = useEffectEvent(() => reveal(active));
  useEffect(() => {
    revealActive();
  }, [active.row, active.col]);
  useLayoutEffect(() => {
    if (!focusPendingRef.current) return;
    focusPendingRef.current = false;
    focusCell(viewportRef.current, active);
  });
  const activate = (cell: CellAddress, moveFocus: boolean): void => {
    focusPendingRef.current = moveFocus;
    setActive(cell);
    props.onActiveCellChange?.(cell);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const next = cellAfterKey(event, active, model, pageRows);
    if (!next) return;
    event.preventDefault();
    reveal(next);
    activate(next, true);
  };
  const onFocus = (event: FocusEvent): void => {
    const focused = addressOfCell(event.target);
    if (focused && (focused.row !== active.row || focused.col !== active.col)) activate(focused, false);
  };
  return { active, onKeyDown, onFocus };
}

function useLaidOutGrid(
  requestedModel: GridModel,
  viewportRef: RefObject<HTMLElement | null>,
  classNames: SheetClassNames | undefined,
) {
  const { sized, resize } = useColumnWidths(requestedModel);
  const font = useGridFont(viewportRef);
  const mountedSignal = useMountedSignal();
  const geometry = geometryOf(sized);
  const { rows, cols, frozen, reveal, pageRows } = useGridVirtualizers(sized, geometry, viewportRef);
  const model = laidOutModel(sized, geometry, frozen);
  const fit = (col: number): void => {
    if (font) resize(col, fittedColumnWidth(model, col, font, rows));
  };
  const frame: GridFrame = { model, geometry, classNames, font, columns: { resize, fit, mountedSignal } };
  return { frame, rows, cols, frozen, reveal, pageRows };
}

/**
 * A virtualized, read-only spreadsheet grid: a WAI-ARIA `grid` with one tab stop that the arrow keys,
 * PageUp, PageDown, Home and End (with Ctrl or ⌘ for the sheet's corners) move; Shift with an arrow is a
 * plain move, as the grid selects one cell at a time. Alt+Left and Alt+Right narrow and widen the focused
 * cell's column, as dragging a column edge does. Only the cells on screen are rendered; the column letters
 * and row numbers stay in view, as do the model's frozen rows and columns (at most 20 rows and 10 columns,
 * and only as many as fit in the viewport), and a merged cell stays drawn while any part of it is on
 * screen (one anchored in a frozen pane is cut at the freeze line). Row heights and column widths are
 * clamped (see `gridSize`). It fills its parent, which must have a size.
 *
 * @example
 * ```tsx
 * <div style={{ height: 400, display: 'flex' }}>
 *   <Grid model={model} aria-label="Sheet1" />
 * </div>
 * ```
 */
export function Grid(props: GridProps): React.JSX.Element {
  'use no memo';
  const { classNames } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const { frame, rows, cols, frozen, reveal, pageRows } = useLaidOutGrid(
    props.model,
    viewportRef,
    classNames,
  );
  const { model, geometry } = frame;
  const { active, onKeyDown, onFocus } = useRovingFocus(model, viewportRef, reveal, props, pageRows);
  const onGridKeyDown = (event: KeyboardEvent): void => {
    const step = event.altKey ? { ArrowLeft: -1, ArrowRight: 1 }[event.key] : undefined;
    if (step === undefined) return onKeyDown(event);
    event.preventDefault();
    frame.columns.resize(active.col, (current) => current + step * KEYBOARD_RESIZE_STEP_PX);
  };
  const drawnRows = cellsToDraw(rows, cols, model.merges, active);
  const rowOf = (drawn: (typeof drawnRows)[number], top: number | undefined): React.JSX.Element => (
    <SheetRow
      key={drawn.row}
      frame={frame}
      row={drawn.row}
      cells={drawn.cells}
      activeCol={drawn.row === active.row ? active.col : undefined}
      top={top}
    />
  );
  const isFrozen = (row: number): boolean => row < frozen.rows;
  return (
    <div ref={viewportRef} {...partProps('sheet-grid-viewport', classNames)}>
      <div
        role="grid"
        aria-label={props['aria-label']}
        aria-readonly
        tabIndex={-1}
        aria-rowcount={ariaIndexOf(model.rowCount - 1, 'row')}
        aria-colcount={ariaIndexOf(model.colCount - 1, 'col')}
        {...partProps('sheet-grid', classNames)}
        style={{
          width: geometry.rowHeaderWidth + geometry.colOffsets[model.colCount]!,
          height: geometry.headerHeight + geometry.rowOffsets[model.rowCount]!,
        }}
        onKeyDown={onGridKeyDown}
        onFocus={onFocus}
      >
        <div role="rowgroup" {...partProps('sheet-grid-head', classNames)}>
          <ColumnHeaderRow frame={frame} cols={cols} />
          {drawnRows.filter((drawn) => isFrozen(drawn.row)).map((drawn) => rowOf(drawn, undefined))}
        </div>
        <div role="rowgroup" {...partProps('sheet-grid-body', classNames)}>
          {drawnRows
            .filter((drawn) => !isFrozen(drawn.row))
            .map((drawn) => rowOf(drawn, geometry.headerHeight + geometry.rowOffsets[drawn.row]!))}
        </div>
      </div>
    </div>
  );
}
