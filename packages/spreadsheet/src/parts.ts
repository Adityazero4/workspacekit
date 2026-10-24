import type { ClassNames } from '@workspacekit/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with
 * the `sheet-` prefix.
 * - The viewer: `sheet-viewer` is the root and `sheet-error` the message shown when a standalone file
 *   cannot be read; `sheet-loading` says the file is opening. `sheet-toolbar` holds the search
 *   (`sheet-search`, its `sheet-search-input` and the `sheet-search-status` match count) and the
 *   `sheet-selection` readout. `sheet-notice` says a sheet was cut short, `sheet-empty` that it has no data.
 *   `sheet-panel` holds the sheet, and `sheet-tabs` its `sheet-tab`s.
 * - The grid: `sheet-grid-viewport` is the scroll container and `sheet-grid` the `grid` inside it.
 *   `sheet-grid-head` holds the sticky column-letter row (`sheet-column-header` cells, each with a
 *   `sheet-column-resizer` edge, after the `sheet-corner`) and the frozen rows; `sheet-grid-body` holds the
 *   scrolled rows. Each `sheet-row` starts with its `sheet-row-header` (the row number) and keeps its frozen
 *   cells in `sheet-frozen`. `sheet-cell` is one cell.
 *
 * @example
 * ```ts
 * SHEET_PARTS.includes('sheet-cell'); // true
 * ```
 */
export const SHEET_PARTS: readonly [
  'sheet-viewer',
  'sheet-error',
  'sheet-loading',
  'sheet-toolbar',
  'sheet-search',
  'sheet-search-input',
  'sheet-search-status',
  'sheet-selection',
  'sheet-notice',
  'sheet-empty',
  'sheet-panel',
  'sheet-tabs',
  'sheet-tab',
  'sheet-grid-viewport',
  'sheet-grid',
  'sheet-grid-head',
  'sheet-grid-body',
  'sheet-row',
  'sheet-corner',
  'sheet-column-header',
  'sheet-column-resizer',
  'sheet-row-header',
  'sheet-frozen',
  'sheet-cell',
] = [
  'sheet-viewer',
  'sheet-error',
  'sheet-loading',
  'sheet-toolbar',
  'sheet-search',
  'sheet-search-input',
  'sheet-search-status',
  'sheet-selection',
  'sheet-notice',
  'sheet-empty',
  'sheet-panel',
  'sheet-tabs',
  'sheet-tab',
  'sheet-grid-viewport',
  'sheet-grid',
  'sheet-grid-head',
  'sheet-grid-body',
  'sheet-row',
  'sheet-corner',
  'sheet-column-header',
  'sheet-column-resizer',
  'sheet-row-header',
  'sheet-frozen',
  'sheet-cell',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: SheetPart = 'sheet-cell';
 * ```
 */
export type SheetPart = (typeof SHEET_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: SheetClassNames = { 'sheet-cell': 'my-cell' };
 * ```
 */
export type SheetClassNames = ClassNames<SheetPart>;
