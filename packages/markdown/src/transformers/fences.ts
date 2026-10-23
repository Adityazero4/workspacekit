import { $createCodeNode, $isCodeNode, CodeNode } from '@lexical/code-core';
import { CODE, type MultilineElementTransformer } from '@lexical/markdown';
import {
  $createTextNode,
  $getState,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import { closesFence, leadingSpaces, openingFence, type Fence } from '../markdownStructure';

const MAX_FENCE_INDENT = 3;
const DEFAULT_FENCE = '```';

const fenceState = createState('fsFence', {
  parse: (value) => (typeof value === 'string' && /^(`{3,}|~{3,})$/.test(value) ? value : DEFAULT_FENCE),
});
const infoState = createState('fsFenceInfo', {
  parse: (value) => (typeof value === 'string' ? value : ''),
});

function runOf(line: string, start: number, character: string): number {
  let end = start;
  while (line[end] === character) end++;
  return end - start;
}

function withoutFenceIndent(line: string, indent: number): string {
  return line.slice(Math.min(indent, leadingSpaces(line)));
}

function $appendCodeBlock(container: ElementNode, fence: Fence, lines: string[]): void {
  const language = fence.info.split(/\s/, 1)[0] ?? '';
  const node = $createCodeNode(language === '' ? undefined : language);
  $setState(node, fenceState, fence.marker);
  $setState(node, infoState, fence.info);
  const code = lines.map((line) => withoutFenceIndent(line, fence.indent)).join('\n');
  if (code !== '') node.append($createTextNode(code));
  container.append(node);
}

function fenceFor(code: string, marker: string): string {
  let longestRun = 0;
  for (const line of code.split('\n')) {
    const indent = leadingSpaces(line);
    if (indent <= MAX_FENCE_INDENT) longestRun = Math.max(longestRun, runOf(line, indent, marker.charAt(0)));
  }
  return longestRun >= marker.length ? marker.charAt(0).repeat(longestRun + 1) : marker;
}

function exportCodeBlock(node: LexicalNode): string | null {
  if (!$isCodeNode(node)) return null;
  const code = node.getTextContent();
  const fence = fenceFor(code, $getState(node, fenceState));
  const info = $getState(node, infoState) || (node.getLanguage() ?? '');
  return `${fence}${info}\n${code === '' ? '' : `${code}\n`}${fence}`;
}

/**
 * Fenced code blocks opened by three or more backticks or tildes (`~~~` included, which Lexical's own code
 * transformer misses), closed by a run of the same character at least as long, or by the end of the text.
 * The fence and its info string are kept on the node and written back unchanged; a fence is lengthened on
 * export only when the code itself holds a line that would close it. Typing ```` ``` ```` in the editor
 * still turns a paragraph into a code block, through Lexical's code shortcut.
 *
 * @example
 * ```ts
 * $convertFromMarkdownString('~~~py\nprint(1)\n~~~', [FENCED_CODE]);
 * ```
 */
export const FENCED_CODE: MultilineElementTransformer = {
  ...CODE,
  dependencies: [CodeNode],
  regExpStart: /^ {0,3}(`{3,}|~{3,})/,
  regExpEnd: undefined,
  export: exportCodeBlock,
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) => {
    const fence = openingFence(lines[startLineIndex] ?? '');
    if (!fence) return null;
    let end = startLineIndex + 1;
    while (end < lines.length && !closesFence(lines[end] ?? '', fence)) end++;
    $appendCodeBlock(rootNode, fence, lines.slice(startLineIndex + 1, end));
    return [true, Math.min(end, lines.length - 1)];
  },
};
