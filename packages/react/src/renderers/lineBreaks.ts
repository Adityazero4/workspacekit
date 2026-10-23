const CR_LF_OR_CR = /\r\n?/g;

/**
 * The text with every line break (`\r\n`, a lone `\r`, or `\n`) turned into `\n`: the form editors work in.
 * Pair it with `lineBreakOf` and `withLineBreak` to hand edits back with the file's own line endings.
 *
 * @example
 * ```ts
 * withLfLineBreaks('one\r\ntwo\r\n'); // 'one\ntwo\n'
 * ```
 */
export function withLfLineBreaks(text: string): string {
  return text.replace(CR_LF_OR_CR, '\n');
}

/**
 * The line break a file uses, judged by its first one: `'\r\n'` when that is CRLF, otherwise `'\n'` (also for
 * text without line breaks). Edits keep it, so saving never rewrites a CRLF file's endings.
 *
 * @example
 * ```ts
 * lineBreakOf('one\r\ntwo'); // '\r\n'
 * ```
 */
export function lineBreakOf(text: string): '\r\n' | '\n' {
  const firstLineFeed = text.indexOf('\n');
  return firstLineFeed > 0 && text[firstLineFeed - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Turns `\n`-only text (as an editor holds it) back into text with `lineBreak` between lines.
 *
 * @example
 * ```ts
 * const saved = withLineBreak(editedText, lineBreakOf(originalText));
 * ```
 */
export function withLineBreak(lfText: string, lineBreak: '\r\n' | '\n'): string {
  return lineBreak === '\n' ? lfText : lfText.replaceAll('\n', lineBreak);
}
