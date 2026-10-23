import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/extension';
import type { ElementTransformer } from '@lexical/markdown';
import { $createHeadingNode, HeadingNode } from '@lexical/rich-text';
import {
  $getState,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
  type ParagraphNode,
} from 'lexical';
import { THEMATIC_BREAK_LINE } from '../markdownStructure';

const DEFAULT_RULE = '---';

const ruleState = createState('fsRule', {
  parse: (value) => (typeof value === 'string' && value.length > 0 ? value : DEFAULT_RULE),
});

function isOneLineParagraph(node: LexicalNode | null): node is ParagraphNode {
  return (
    $isParagraphNode(node) && node.getTextContentSize() > 0 && !node.getChildren().some($isLineBreakNode)
  );
}

function $headingFromParagraph(underlined: ElementNode, tag: 'h1' | 'h2'): boolean {
  const paragraph = underlined.getPreviousSibling();
  if (!isOneLineParagraph(paragraph)) return false;
  paragraph.replace($createHeadingNode(tag).append(...paragraph.getChildren()));
  underlined.remove();
  return true;
}

const isSetextUnderline = (line: string): boolean => /^ {0,3}-+[ \t]*$/.test(line);

/**
 * Thematic breaks (`***`, `---`, `___`, with or without spaces between the characters) as horizontal rules.
 * The line is kept on the node and written back unchanged, so `***` stays `***` (Lexical's own export
 * escapes it to `\*\*\*`). A run of `-` right under a one-line paragraph is a setext heading instead, and
 * becomes a level 2 heading. It must come before the list transformers, which would read `* * *` as a
 * bullet. Typing `---` and a space in the editor inserts a rule.
 *
 * @example
 * ```ts
 * $convertFromMarkdownString('***', [THEMATIC_BREAK]);
 * ```
 */
export const THEMATIC_BREAK: ElementTransformer = {
  dependencies: [HorizontalRuleNode, HeadingNode],
  export: (node) => ($isHorizontalRuleNode(node) ? $getState(node, ruleState) : null),
  regExp: THEMATIC_BREAK_LINE,
  replace: (parentNode, _children, match, isImport) => {
    const line = match[0] ?? '';
    if (isImport && isSetextUnderline(line) && $headingFromParagraph(parentNode, 'h2')) return;
    const rule = $createHorizontalRuleNode();
    $setState(rule, ruleState, line.trim());
    if (isImport) return void parentNode.replace(rule);
    if (parentNode.getNextSibling() !== null) parentNode.replace(rule);
    else parentNode.insertBefore(rule);
    rule.selectNext();
  },
  type: 'element',
};

/**
 * A run of `=` right under a one-line paragraph: a setext level 1 heading, written back as `# Heading`.
 * Anywhere else the line stays text.
 *
 * @example
 * ```ts
 * $convertFromMarkdownString('Title\n=====', [SETEXT_HEADING]);
 * ```
 */
export const SETEXT_HEADING: ElementTransformer = {
  dependencies: [HeadingNode],
  export: () => null,
  regExp: /^ {0,3}=+[ \t]*$/,
  replace: (parentNode, children, match, isImport) => {
    if (isImport && $headingFromParagraph(parentNode, 'h1')) return;
    const [text] = children;
    if ($isTextNode(text)) text.setTextContent(match[0] ?? '');
  },
  type: 'element',
};
