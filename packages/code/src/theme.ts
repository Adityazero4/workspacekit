import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const MONOSPACE = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const INPUT = {
  color: 'inherit',
  backgroundColor: 'var(--fs-bg)',
  border: '1px solid var(--fs-input-border)',
};

const editorColors = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fs-fg)',
    backgroundColor: 'var(--fs-bg)',
    fontSize: 'var(--fs-font-size)',
  },
  '&.cm-focused': { outline: '2px solid var(--fs-focus)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: MONOSPACE, lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--fs-fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fs-fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--fs-bg-selected)',
  },
  '.cm-gutters': {
    color: 'var(--fs-muted)',
    backgroundColor: 'var(--fs-bg)',
    borderRight: '1px solid var(--fs-border)',
  },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--fs-bg-selected)' },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--fs-danger)', backgroundColor: 'transparent' },
  '.cm-specialChar': { color: 'var(--fs-danger)' },
  '.cm-searchMatch': { backgroundColor: 'var(--fs-flash)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--fs-bg-selected)' },
  '.cm-panels': { color: 'var(--fs-fg)', backgroundColor: 'var(--fs-bg-hover)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--fs-border)' },
  '.cm-textfield': INPUT,
  '.cm-button': { ...INPUT, backgroundImage: 'none' },
});

const syntaxColors = HighlightStyle.define([
  { tag: [tags.keyword, tags.bool, tags.null, tags.atom, tags.self], color: 'var(--fs-syntax-keyword)' },
  { tag: [tags.string, tags.regexp, tags.character, tags.url], color: 'var(--fs-syntax-string)' },
  { tag: tags.number, color: 'var(--fs-syntax-number)' },
  { tag: [tags.comment, tags.meta], color: 'var(--fs-syntax-comment)', fontStyle: 'italic' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    color: 'var(--fs-syntax-function)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--fs-syntax-type)' },
  { tag: [tags.variableName, tags.propertyName, tags.labelName], color: 'var(--fs-syntax-variable)' },
  { tag: tags.operator, color: 'var(--fs-syntax-operator)' },
  { tag: [tags.tagName, tags.heading], color: 'var(--fs-syntax-tag)' },
  { tag: tags.attributeName, color: 'var(--fs-syntax-attribute)' },
  { tag: [tags.heading, tags.strong], fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--fs-danger)' },
]);

/**
 * The editor's look, entirely from `--fs-*` custom properties: colors, font size and focus ring from the
 * shared tokens, syntax colors from the `--fs-syntax-*` tokens. One theme serves light and dark, because the
 * tokens change with `prefers-color-scheme` and `data-theme`.
 *
 * @example
 * ```ts
 * EditorState.create({ doc: text, extensions: [codeTheme] });
 * ```
 */
export const codeTheme: Extension = [editorColors, syntaxHighlighting(syntaxColors)];
