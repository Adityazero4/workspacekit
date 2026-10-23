const MOST_ROW_POINTS = 409;
const MOST_COLUMN_CHARACTERS = 255;
const LEAST_FONT_POINTS = 1;
const MOST_FONT_POINTS = 409;
const PX_PER_POINT = 4 / 3;
const MAXIMUM_DIGIT_WIDTH_PX = 7;
const COLUMN_PADDING_256THS = Math.trunc(128 / MAXIMUM_DIGIT_WIDTH_PX);
const MOST_ROW_PX = Math.round(MOST_ROW_POINTS * PX_PER_POINT);
const MOST_COLUMN_PX = Math.trunc(
  ((256 * MOST_COLUMN_CHARACTERS + COLUMN_PADDING_256THS) / 256) * MAXIMUM_DIGIT_WIDTH_PX,
);

/**
 * A size read from a document: a CSS px value, `'hidden'` (the document says 0), or `undefined` when the
 * value is not a usable number (NaN, infinite, negative) and the default applies.
 *
 * @example
 * ```ts
 * const size: DocumentSize = 'hidden';
 * ```
 */
export type DocumentSize = number | 'hidden' | undefined;

function documentSize(value: number, most: number, toPx: (value: number) => number): DocumentSize {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return 'hidden';
  return toPx(Math.min(value, most));
}

/**
 * A row height in points (`<row ht>`, `defaultRowHeight`) as CSS px, clamped to Excel's 409 pt.
 *
 * @example
 * ```ts
 * rowHeightPx(15); // 20
 * rowHeightPx(1e300); // 545
 * ```
 */
export const rowHeightPx = (points: number): DocumentSize =>
  documentSize(points, MOST_ROW_POINTS, (clamped) => Math.round(clamped * PX_PER_POINT));

/**
 * A column width in characters (`<col width>`, `defaultColWidth`) as CSS px, by Excel's formula, clamped
 * to Excel's 255 characters.
 *
 * @example
 * ```ts
 * colWidthPx(9.140625); // 64
 * colWidthPx(Number.NaN); // undefined
 * ```
 */
export const colWidthPx = (characters: number): DocumentSize =>
  documentSize(characters, MOST_COLUMN_CHARACTERS, (clamped) =>
    Math.trunc(((256 * clamped + COLUMN_PADDING_256THS) / 256) * MAXIMUM_DIGIT_WIDTH_PX),
  );

/**
 * A CSS px size from another engine (SheetJS's `hpx`/`wpx`), kept within the same limits as `rowHeightPx`
 * and `colWidthPx`.
 *
 * @example
 * ```ts
 * pxSize(30, 'row'); // 30
 * ```
 */
export const pxSize = (px: number | undefined, axis: 'row' | 'col'): DocumentSize =>
  px === undefined
    ? undefined
    : documentSize(px, axis === 'row' ? MOST_ROW_PX : MOST_COLUMN_PX, (clamped) => clamped);

/**
 * A font size in points, or `undefined` outside Excel's 1 to 409 pt (or not a number).
 *
 * @example
 * ```ts
 * fontPoints(1e9); // undefined
 * ```
 */
export const fontPoints = (points: number): number | undefined =>
  Number.isFinite(points) && points >= LEAST_FONT_POINTS && points <= MOST_FONT_POINTS ? points : undefined;
