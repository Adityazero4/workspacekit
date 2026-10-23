/**
 * A Markdown document in three parts: `before` (YAML frontmatter, if any, and the blank lines that follow
 * it), the `body` the editor shows, and `after` (the trailing line breaks). The editor never sees `before`
 * or `after`, so they are written back exactly as they were read.
 *
 * @example
 * ```ts
 * const parts: DocumentParts = { before: '---\ntitle: A\n---\n\n', body: '# A', after: '\n' };
 * ```
 */
export interface DocumentParts {
  before: string;
  body: string;
  after: string;
}

const FRONTMATTER_FENCE = '---';
const FRONTMATTER_CLOSERS: ReadonlySet<string> = new Set(['---', '...']);

function frontmatterLength(text: string): number {
  if (!text.startsWith(`${FRONTMATTER_FENCE}\n`)) return 0;
  let lineStart = FRONTMATTER_FENCE.length + 1;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (FRONTMATTER_CLOSERS.has(text.slice(lineStart, lineEnd))) {
      return newline === -1 ? lineEnd : lineEnd + 1;
    }
    if (newline === -1) return 0;
    lineStart = newline + 1;
  }
  return 0;
}

function lineBreaksFrom(text: string, start: number): number {
  let end = start;
  while (end < text.length && text.charCodeAt(end) === 10) end++;
  return end;
}

function lineBreaksBefore(text: string, end: number, floor: number): number {
  let start = end;
  while (start > floor && text.charCodeAt(start - 1) === 10) start--;
  return start;
}

/**
 * Splits a Markdown text (with `\n` line breaks) into its frontmatter and leading blank lines, its body and
 * its trailing line breaks, in one linear scan. Frontmatter is a block that starts the text with a `---`
 * line and is closed by a `---` or `...` line; an unclosed block is ordinary body text.
 *
 * @example
 * ```ts
 * splitDocument('---\nt: A\n---\n\n# A\n'); // { before: '---\nt: A\n---\n\n', body: '# A', after: '\n' }
 * ```
 */
export function splitDocument(text: string): DocumentParts {
  const bodyStart = lineBreaksFrom(text, frontmatterLength(text));
  const bodyEnd = lineBreaksBefore(text, text.length, bodyStart);
  return {
    before: text.slice(0, bodyStart),
    body: text.slice(bodyStart, bodyEnd),
    after: text.slice(bodyEnd),
  };
}

/**
 * Puts a document split by `splitDocument` back together, usually with a body the editor re-serialised.
 *
 * @example
 * ```ts
 * joinDocument({ ...splitDocument(text), body: exportedBody });
 * ```
 */
export function joinDocument(parts: DocumentParts): string {
  return parts.before + parts.body + parts.after;
}
