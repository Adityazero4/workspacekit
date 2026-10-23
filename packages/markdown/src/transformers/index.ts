import { CodeNode } from '@lexical/code-core';
import { HorizontalRuleNode } from '@lexical/extension';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  HEADING,
  ORDERED_LIST,
  QUOTE,
  type Transformer,
  UNORDERED_LIST,
} from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import type { Klass, LexicalNode } from 'lexical';
import { INLINE_TRANSFORMERS } from './emphasis';
import { FENCED_CODE } from './fences';
import { PARAGRAPH_ESCAPES } from './paragraph';
import { SETEXT_HEADING, THEMATIC_BREAK } from './rule';
import { GFM_TABLE } from './table';

/**
 * Every node type the Markdown editor uses.
 *
 * @example
 * ```ts
 * const initialConfig = { namespace: 'markdown', nodes: MARKDOWN_NODES, onError };
 * ```
 */
export const MARKDOWN_NODES: Klass<LexicalNode>[] = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  CodeNode,
  HorizontalRuleNode,
  TableNode,
  TableRowNode,
  TableCellNode,
];

/**
 * The transformers the editor reads and writes Markdown with: Lexical's headings, quotes and lists, and
 * this package's fenced code (with `~~~`), GitHub tables, thematic breaks (with `***`), setext headings
 * and paragraph escapes, plus the inline transformers. Rules come before lists so `* * *` is a rule.
 *
 * @example
 * ```ts
 * $convertFromMarkdownString(markdown, MARKDOWN_TRANSFORMERS);
 * ```
 */
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
  FENCED_CODE,
  GFM_TABLE,
  THEMATIC_BREAK,
  SETEXT_HEADING,
  HEADING,
  QUOTE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  PARAGRAPH_ESCAPES,
  ...INLINE_TRANSFORMERS,
];

/**
 * Replaces the editor's content with the Markdown `body` (no frontmatter; `\n` line breaks). Call it inside
 * `editor.update`.
 *
 * @example
 * ```ts
 * editor.update(() => $importMarkdown('# Title'), { tag: REMOTE_UPDATE_TAG });
 * ```
 */
export function $importMarkdown(body: string): void {
  $convertFromMarkdownString(body, MARKDOWN_TRANSFORMERS);
}

/**
 * The editor's content as Markdown. Call it inside `editorState.read` or `editor.update`.
 *
 * @example
 * ```ts
 * const body = editor.getEditorState().read($exportMarkdown);
 * ```
 */
export function $exportMarkdown(): string {
  return $convertToMarkdownString(MARKDOWN_TRANSFORMERS);
}
