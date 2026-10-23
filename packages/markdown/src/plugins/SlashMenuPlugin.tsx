'use client';
import { $createCodeNode } from '@lexical/code-core';
import { $createHorizontalRuleNode } from '@lexical/extension';
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
  type MenuRenderFn,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import { INSERT_TABLE_COMMAND } from '@lexical/table';
import { $insertNodeToNearestRoot } from '@lexical/utils';
import { $createParagraphNode, $getSelection, type ElementNode, type LexicalEditor } from 'lexical';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarkdownClassNames } from '../parts';

class BlockOption extends MenuOption {
  readonly title: string;
  readonly insert: (editor: LexicalEditor) => void;

  constructor(title: string, insert: (editor: LexicalEditor) => void) {
    super(title);
    this.title = title;
    this.insert = insert;
  }
}

const turnInto = (createBlock: () => ElementNode) => (): void => $setBlocksType($getSelection(), createBlock);
const heading = (tag: HeadingTagType): (() => void) => turnInto(() => $createHeadingNode(tag));

const BLOCK_OPTIONS: readonly BlockOption[] = [
  new BlockOption('Text', turnInto($createParagraphNode)),
  new BlockOption('Heading 1', heading('h1')),
  new BlockOption('Heading 2', heading('h2')),
  new BlockOption('Heading 3', heading('h3')),
  new BlockOption('Bulleted list', (editor) =>
    editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
  ),
  new BlockOption('Numbered list', (editor) =>
    editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
  ),
  new BlockOption('Check list', (editor) => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)),
  new BlockOption('Quote', turnInto($createQuoteNode)),
  new BlockOption(
    'Code block',
    turnInto(() => $createCodeNode()),
  ),
  new BlockOption('Divider', () => void $insertNodeToNearestRoot($createHorizontalRuleNode())),
  new BlockOption('Table', (editor) =>
    editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: '2', rows: '2' }),
  ),
];

function SlashMenuOptions(props: {
  anchor: HTMLElement;
  options: BlockOption[];
  selectedIndex: number | null;
  choose: (option: BlockOption) => void;
  highlight: (index: number) => void;
}): React.JSX.Element {
  const { anchor, options, selectedIndex, choose, highlight } = props;
  useEffect(() => {
    anchor.setAttribute('aria-label', 'Insert block');
    anchor.setAttribute('data-fs-part', 'md-slash-menu');
  }, [anchor]);
  return createPortal(
    options.map((option, index) => (
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the text keeps focus and picks options with Enter/Tab through aria-activedescendant
      <div
        key={option.key}
        id={`typeahead-item-${index}`}
        ref={(element) => option.setRefElement(element)}
        role="option"
        tabIndex={-1}
        aria-selected={selectedIndex === index}
        onMouseEnter={() => highlight(index)}
        onClick={() => choose(option)}
      >
        {option.title}
      </div>
    )),
    anchor,
  );
}

const renderMenu: MenuRenderFn<BlockOption> = (anchor, menu) =>
  anchor.current && menu.options.length > 0 ? (
    <SlashMenuOptions
      anchor={anchor.current}
      options={menu.options}
      selectedIndex={menu.selectedIndex}
      choose={menu.selectOptionAndCleanUp}
      highlight={menu.setHighlightedIndex}
    />
  ) : null;

/**
 * The block menu: typing `/` opens a list of blocks (text, headings, lists, quote, code, divider, table),
 * filtered by what follows the slash. ArrowUp/ArrowDown move through it, Enter or Tab picks, Escape
 * closes; the text keeps focus and points at the highlighted option with `aria-activedescendant`.
 *
 * @example
 * ```tsx
 * <SlashMenuPlugin container={container} />
 * ```
 */
export function SlashMenuPlugin(props: {
  container: HTMLElement;
  classNames?: MarkdownClassNames;
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const triggerFn = useBasicTypeaheadTriggerMatch('/', { minLength: 0 });
  const wanted = (query ?? '').toLowerCase();
  const options = BLOCK_OPTIONS.filter((option) => option.title.toLowerCase().includes(wanted));
  return (
    <LexicalTypeaheadMenuPlugin<BlockOption>
      options={options}
      onQueryChange={setQuery}
      triggerFn={triggerFn}
      parent={props.container}
      anchorClassName={props.classNames?.['md-slash-menu']}
      menuRenderFn={renderMenu}
      onSelectOption={(option, textNode, closeMenu) => {
        textNode?.remove();
        option.insert(editor);
        closeMenu();
      }}
    />
  );
}
