import type { ElementTransformer } from '@lexical/markdown';
import { $isParagraphNode, type ElementNode, type LexicalNode } from 'lexical';
import { THEMATIC_BREAK_LINE } from '../markdownStructure';

const MAX_INDENT = 3;
const NEVER_MATCHES = /(?!)/;

const isBlank = (character: string | undefined): boolean => character === ' ' || character === '\t';
const isDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= '0' && character <= '9';

function headingMarkerEnd(line: string, start: number): number {
  let end = start;
  while (line[end] === '#') end++;
  return end - start <= 6 && isBlank(line[end]) ? end : -1;
}

function orderedMarkerEnd(line: string, start: number): number {
  let end = start;
  while (isDigit(line[end])) end++;
  return end > start && line[end] === '.' && isBlank(line[end + 1]) ? end : -1;
}

function escapePosition(line: string): number {
  let start = 0;
  while (start < MAX_INDENT && line[start] === ' ') start++;
  const first = line[start];
  if (THEMATIC_BREAK_LINE.test(line)) return start;
  if (first === '#') return headingMarkerEnd(line, start) === -1 ? -1 : start;
  if (first === '>' || first === '-' || first === '+') return isBlank(line[start + 1]) ? start : -1;
  return orderedMarkerEnd(line, start);
}

/**
 * The line with a backslash added where its start would otherwise read as a block (a heading, quote, list
 * item or rule) the next time the file is opened. Text such as `1\. not a list` is read as the plain text
 * `1. not a list`; without this, Lexical writes it back unescaped and the line silently becomes a list.
 *
 * @example
 * ```ts
 * escapeBlockStart('1. not a list'); // '1\\. not a list'
 * ```
 */
export function escapeBlockStart(line: string): string {
  const position = escapePosition(line);
  return position === -1 ? line : `${line.slice(0, position)}\\${line.slice(position)}`;
}

/**
 * Writes paragraphs (only; it never matches on import) with `escapeBlockStart` applied to each line.
 *
 * @example
 * ```ts
 * $convertToMarkdownString([PARAGRAPH_ESCAPES, ...INLINE_TRANSFORMERS]);
 * ```
 */
export const PARAGRAPH_ESCAPES: ElementTransformer = {
  dependencies: [],
  export: (node: LexicalNode, exportChildren: (node: ElementNode) => string) =>
    $isParagraphNode(node) ? exportChildren(node).split('\n').map(escapeBlockStart).join('\n') : null,
  regExp: NEVER_MATCHES,
  replace: () => false,
  type: 'element',
};
