import type { PointerEvent } from 'react';
import { cellFont, textWidth } from './measure';
import type { GridModel } from './model';

const NARROWEST_COLUMN_PX = 16;
const WIDEST_FITTED_COLUMN_PX = 800;
const FIT_PADDING_PX = 12;
const FIT_SAMPLE_ROWS = 1000;

/**
 * The width that fits the widest text in a column (its header letters included), measured on a canvas in
 * each cell's font, between 16 and 800 px. It looks at the rows on screen plus the first 1,000 rows, so a
 * double-click costs the same on a 20,000-row sheet as on a short one.
 *
 * @example
 * ```ts
 * fittedColumnWidth(model, 2, { family: 'system-ui', size: '13px' }, [40, 41, 42]); // 96
 * ```
 */
export function fittedColumnWidth(
  model: GridModel,
  col: number,
  font: { family: string; size: string },
  rowsOnScreen: readonly number[],
): number {
  let widest = textWidth(model.colLabel?.(col) ?? '', cellFont(font, undefined));
  const sampled = Array.from({ length: Math.min(model.rowCount, FIT_SAMPLE_ROWS) }, (_, row) => row);
  for (const row of new Set([...sampled, ...rowsOnScreen])) {
    const cell = model.cell(row, col);
    if (cell && cell.text !== '' && cell.wrap !== 'wrap') {
      widest = Math.max(widest, textWidth(cell.text, cellFont(font, cell.style)));
    }
  }
  return Math.min(WIDEST_FITTED_COLUMN_PX, Math.max(NARROWEST_COLUMN_PX, Math.ceil(widest + FIT_PADDING_PX)));
}

/**
 * Starts dragging a column's right edge: every move of that pointer anywhere in the document reports the
 * column's new width (never under 16 px) until the button is released, or until `signal` aborts (the grid
 * aborts it when it unmounts, so no listener outlives it).
 *
 * @example
 * ```tsx
 * <div onPointerDown={(event) => dragColumnEdge(event, 90, (width) => resize(3, width), signal)} />
 * ```
 */
export function dragColumnEdge(
  event: PointerEvent<HTMLElement>,
  startWidth: number,
  onWidth: (width: number) => void,
  signal: AbortSignal,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const owner = event.currentTarget.ownerDocument;
  const onMove = (move: globalThis.PointerEvent): void => {
    if (move.pointerId !== pointerId) return;
    onWidth(Math.max(NARROWEST_COLUMN_PX, Math.round(startWidth + move.clientX - startX)));
  };
  const stop = (): void => {
    owner.removeEventListener('pointermove', onMove);
    owner.removeEventListener('pointerup', onEnd);
    owner.removeEventListener('pointercancel', onEnd);
    signal.removeEventListener('abort', stop);
  };
  const onEnd = (end: globalThis.PointerEvent): void => {
    if (end.pointerId === pointerId) stop();
  };
  if (signal.aborted) return;
  owner.addEventListener('pointermove', onMove);
  owner.addEventListener('pointerup', onEnd);
  owner.addEventListener('pointercancel', onEnd);
  signal.addEventListener('abort', stop);
}
