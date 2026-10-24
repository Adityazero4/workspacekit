import { withLfLineBreaks } from '@workspacekit/react/renderer-kit';
import { splitDocument } from './frontmatter';
import {
  closesFence,
  opensTable,
  openingFence,
  tableRowContent,
  THEMATIC_BREAK_LINE,
  type Fence,
} from './markdownStructure';

/**
 * The longest Markdown text, in characters, the rendered (WYSIWYG) view opens; a longer one is shown as
 * source. The registry entry declines files over this many bytes so that the code renderer takes them.
 *
 * @example
 * ```ts
 * const showRendered = text.length <= RENDERED_VIEW_MAX_CHARACTERS;
 * ```
 */
export const RENDERED_VIEW_MAX_CHARACTERS = 500_000;

const IMPORT_WORK_BUDGET = 10_000_000;
const MERGED_LINE_WEIGHT = 3;
const MAX_LIST_INDENT_COLUMNS = 256;
const TAB_COLUMNS = 4;
const REFUSED = Number.POSITIVE_INFINITY;

const codesOf = (characters: string): ReadonlySet<number> =>
  new Set([...characters].map((character) => character.charCodeAt(0)));
const INLINE_MARKERS = codesOf('*_~`[]()!\\');
const LIST_BULLETS = codesOf('-+*');
const SPACE = 32;
const TAB = 9;
const PERIOD = 46;
const HASH = 35;
const MAX_HEADING_LEVEL = 6;

type LineKind = 'blank' | 'block' | 'text';

const isBlank = (code: number): boolean => code === SPACE || code === TAB;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

function inlineMarkers(line: string): number {
  let markers = 0;
  for (let index = 0; index < line.length; index++) if (INLINE_MARKERS.has(line.charCodeAt(index))) markers++;
  return markers;
}

function indentOf(line: string): { columns: number; end: number } {
  let columns = 0;
  let end = 0;
  for (; isBlank(line.charCodeAt(end)); end++) columns += line.charCodeAt(end) === TAB ? TAB_COLUMNS : 1;
  return { columns, end };
}

function listMarkerEnd(line: string, start: number): number {
  if (LIST_BULLETS.has(line.charCodeAt(start))) return start + 1;
  let end = start;
  while (isDigit(line.charCodeAt(end))) end++;
  return end > start && line.charCodeAt(end) === PERIOD ? end + 1 : -1;
}

function isHeading(line: string): boolean {
  let level = 0;
  while (line.charCodeAt(level) === HASH) level++;
  return level >= 1 && level <= MAX_HEADING_LEVEL && isBlank(line.charCodeAt(level));
}

function kindOf(line: string): LineKind {
  const { end } = indentOf(line);
  if (end === line.length) return 'blank';
  const markerEnd = listMarkerEnd(line, end);
  const isListItem = markerEnd !== -1 && isBlank(line.charCodeAt(markerEnd));
  return isListItem || isHeading(line) || THEMATIC_BREAK_LINE.test(line) ? 'block' : 'text';
}

function isNestedTooDeep(line: string): boolean {
  const { columns, end } = indentOf(line);
  return columns > MAX_LIST_INDENT_COLUMNS && listMarkerEnd(line, end) !== -1;
}

interface Scan {
  work: number;
  blockLength: number;
  fence: Fence | null;
  inTable: boolean;
}

function chargeLine(scan: Scan, lines: readonly string[], index: number): void {
  const line = lines[index] ?? '';
  scan.work += line.length * (inlineMarkers(line) + 1);
  if (scan.fence) {
    if (closesFence(line, scan.fence)) scan.fence = null;
    return;
  }
  scan.fence = openingFence(line);
  scan.inTable = (scan.inTable && tableRowContent(line) !== null) || opensTable(lines, index);
  const kind = scan.fence || scan.inTable ? 'block' : kindOf(line);
  if (kind === 'text') {
    scan.work += MERGED_LINE_WEIGHT * scan.blockLength;
    scan.blockLength += line.length;
  } else {
    scan.blockLength = kind === 'blank' || scan.fence ? 0 : line.length;
  }
}

/**
 * An upper estimate of the work Lexical's Markdown import does on a document `body` (frontmatter already
 * split off), in one linear pass. Every line is charged its length × (inline markers + 1), because the
 * import re-scans the rest of a line for every inline span it finds; a line merged into the paragraph,
 * quote or list item above it is also charged that block's length, because the import re-measures the
 * block for every merge. Only structure the transformers themselves recognise (the same predicates:
 * fences, tables, headings, list items, rules) is spared the merge charge, never the per-character one. A
 * list item indented more than 256 columns (about 64 levels) is refused outright: Lexical nests a list per
 * level and overflows the stack.
 *
 * @example
 * ```ts
 * estimatedImportWork('*a* '.repeat(50_000)) > 10_000_000; // true
 * ```
 */
export function estimatedImportWork(body: string): number {
  const lines = body.split('\n');
  const scan: Scan = { work: 0, blockLength: 0, fence: null, inTable: false };
  for (let index = 0; index < lines.length; index++) {
    if (scan.fence === null && isNestedTooDeep(lines[index] ?? '')) return REFUSED;
    chargeLine(scan, lines, index);
  }
  return scan.work;
}

/**
 * Whether the rendered view may open `markdown`: at most 500,000 characters, and an estimated import work
 * for its body (see `estimatedImportWork`) within a fixed budget. Anything else, such as a hostile file of
 * 50,000 emphasis spans on one line, opens as source, so the editor engine never does unbounded work.
 *
 * @example
 * ```ts
 * const mode = fitsTheRenderedView(text) ? 'rendered' : 'source';
 * ```
 */
export function fitsTheRenderedView(markdown: string): boolean {
  if (markdown.length > RENDERED_VIEW_MAX_CHARACTERS) return false;
  return estimatedImportWork(splitDocument(withLfLineBreaks(markdown)).body) <= IMPORT_WORK_BUDGET;
}
