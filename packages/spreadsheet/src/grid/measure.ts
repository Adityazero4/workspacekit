import { gridFontPoints } from './model';

const MOST_CACHED_WIDTHS = 20_000;
const FALLBACK_CHARACTER_WIDTH = 7;
const MEASURED_CHARACTERS = 256;

let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/**
 * The width in CSS px of `text` drawn in `font` (a CSS `font` shorthand), measured on a canvas and cached.
 * Only the first 256 characters are measured (and kept as the cache key): that is already wider than any
 * column the grid sizes, spills or fits to, so a cell of 32,767 characters costs no more than a short one.
 * Without a canvas (server rendering) it estimates 7 px per character.
 *
 * @example
 * ```ts
 * textWidth('1,234.50', '13px system-ui'); // 52.3
 * ```
 */
export function textWidth(text: string, font: string): number {
  const measured = text.length > MEASURED_CHARACTERS ? text.slice(0, MEASURED_CHARACTERS) : text;
  context ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return measured.length * FALLBACK_CHARACTER_WIDTH;
  const key = `${font}\n${measured}`;
  let width = widths.get(key);
  if (width === undefined) {
    if (widths.size >= MOST_CACHED_WIDTHS) widths.clear();
    context.font = font;
    width = context.measureText(measured).width;
    widths.set(key, width);
  }
  return width;
}

/**
 * The CSS `font` shorthand a cell is drawn in: the grid's own font, made bold or italic, or resized to the
 * workbook's point size.
 *
 * @example
 * ```ts
 * cellFont({ family: 'system-ui', size: '13px' }, { bold: true }); // 'normal bold 13px system-ui'
 * ```
 */
export function cellFont(
  base: { family: string; size: string },
  style: { bold?: boolean; italic?: boolean; fontSize?: number } | undefined,
): string {
  const points = gridFontPoints(style?.fontSize);
  const size = points === undefined ? base.size : `${points}pt`;
  return `${style?.italic ? 'italic' : 'normal'} ${style?.bold ? 'bold' : 'normal'} ${size} ${base.family}`;
}
