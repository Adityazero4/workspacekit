const MAX_BLOCK_INDENT = 3;
const BACKSLASH = 92;
const PIPE = 124;

/**
 * An opening code fence: its indent (up to three spaces), its marker (three or more backticks or tildes)
 * and the info string after it.
 *
 * @example
 * ```ts
 * const fence: Fence = { indent: 0, marker: '~~~', info: 'python title="a.py"' };
 * ```
 */
export interface Fence {
  indent: number;
  marker: string;
  info: string;
}

/**
 * A table column's alignment, as written in the delimiter row: `:--` left, `:-:` center, `--:` right,
 * `---` none (`''`).
 *
 * @example
 * ```ts
 * const alignment: ColumnAlignment = 'center';
 * ```
 */
export type ColumnAlignment = 'left' | 'center' | 'right' | '';

/**
 * How many spaces start `line`.
 *
 * @example
 * ```ts
 * leadingSpaces('   x'); // 3
 * ```
 */
export function leadingSpaces(line: string): number {
  let count = 0;
  while (line.charCodeAt(count) === 32) count++;
  return count;
}

function runOf(line: string, start: number, character: string): number {
  let end = start;
  while (line[end] === character) end++;
  return end - start;
}

/**
 * The fence `line` opens, or `null`: up to three spaces, then three or more backticks or tildes, then an
 * info string (which, after backticks, may not hold a backtick). This one predicate decides fences for both
 * the import and the rendered view's work estimate.
 *
 * @example
 * ```ts
 * openingFence('~~~sh'); // { indent: 0, marker: '~~~', info: 'sh' }
 * ```
 */
export function openingFence(line: string): Fence | null {
  const indent = leadingSpaces(line);
  const character = line.charAt(indent);
  if (indent > MAX_BLOCK_INDENT || (character !== '`' && character !== '~')) return null;
  const length = runOf(line, indent, character);
  const info = line.slice(indent + length).trim();
  if (length < 3 || (character === '`' && info.includes('`'))) return null;
  return { indent, marker: character.repeat(length), info };
}

/**
 * Whether `line` closes `fence`: up to three spaces, a run of the fence's character at least as long as
 * its marker, and nothing else.
 *
 * @example
 * ```ts
 * closesFence('````', { indent: 0, marker: '```', info: '' }); // true
 * ```
 */
export function closesFence(line: string, fence: Fence): boolean {
  const indent = leadingSpaces(line);
  if (indent > MAX_BLOCK_INDENT) return false;
  const length = runOf(line, indent, fence.marker.charAt(0));
  return length >= fence.marker.length && line.slice(indent + length).trim() === '';
}

/**
 * The trimmed table row `line` holds (it starts with `|` after at most three spaces), or `null`.
 *
 * @example
 * ```ts
 * tableRowContent('| a | b |  '); // '| a | b |'
 * ```
 */
export function tableRowContent(line: string): string | null {
  const trimmed = line.trim();
  const indent = line.length - line.trimStart().length;
  return indent <= MAX_BLOCK_INDENT && trimmed.charCodeAt(0) === PIPE ? trimmed : null;
}

/**
 * The cells of a table row (from `tableRowContent`), split on unescaped pipes, with each `\|` turned into
 * `|`, in one linear pass. A trailing empty cell after the closing pipe is dropped.
 *
 * @example
 * ```ts
 * tableCells('| a \\| b | c |'); // ['a | b', 'c']
 * ```
 */
export function tableCells(row: string): string[] {
  const cells: string[] = [];
  let cell: string[] = [];
  let backslashes = 0;
  for (let index = 1; index < row.length; index++) {
    const character = row.charCodeAt(index);
    const isEscapedPipe = character === PIPE && backslashes % 2 === 1;
    if (character === PIPE && !isEscapedPipe) {
      cells.push(cell.join('').trim());
      cell = [];
    } else {
      if (isEscapedPipe) cell.pop();
      cell.push(row.charAt(index));
    }
    backslashes = character === BACKSLASH ? backslashes + 1 : 0;
  }
  const last = cell.join('').trim();
  if (last !== '') cells.push(last);
  return cells;
}

function alignmentOf(delimiterCell: string): ColumnAlignment | null {
  const startsWithColon = delimiterCell.startsWith(':');
  const endsWithColon = delimiterCell.length > 1 && delimiterCell.endsWith(':');
  const start = startsWithColon ? 1 : 0;
  const end = delimiterCell.length - (endsWithColon ? 1 : 0);
  if (start >= end) return null;
  for (let index = start; index < end; index++) if (delimiterCell[index] !== '-') return null;
  if (startsWithColon && endsWithColon) return 'center';
  if (endsWithColon) return 'right';
  return startsWithColon ? 'left' : '';
}

/**
 * The column alignments of a delimiter row (from `tableRowContent`), or `null` when it is not one: every
 * cell must be dashes with optional colons at either end.
 *
 * @example
 * ```ts
 * delimiterAlignments('|:--|--:|'); // ['left', 'right']
 * ```
 */
export function delimiterAlignments(row: string): ColumnAlignment[] | null {
  const alignments: ColumnAlignment[] = [];
  for (const cell of tableCells(row)) {
    const alignment = alignmentOf(cell);
    if (alignment === null) return null;
    alignments.push(alignment);
  }
  return alignments.length > 0 ? alignments : null;
}

/**
 * Whether lines `index` and `index + 1` open a table: a row followed by a delimiter row. The import reads a
 * table exactly when this holds.
 *
 * @example
 * ```ts
 * opensTable(['| a |', '|---|'], 0); // true
 * ```
 */
export function opensTable(lines: readonly string[], index: number): boolean {
  if (tableRowContent(lines[index] ?? '') === null) return false;
  const delimiterRow = tableRowContent(lines[index + 1] ?? '');
  return delimiterRow !== null && delimiterAlignments(delimiterRow) !== null;
}

/**
 * A thematic break: up to three spaces, then three or more `*`, `-` or `_` (the same one), optionally
 * separated by spaces or tabs. Linear: the separators and the character can't match the same text.
 *
 * @example
 * ```ts
 * THEMATIC_BREAK_LINE.test('* * *'); // true
 * ```
 */
export const THEMATIC_BREAK_LINE: RegExp = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
