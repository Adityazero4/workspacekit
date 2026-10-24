import type { ClassNames } from '@workspacekit/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with the
 * `md-` prefix. `md-viewer` is the root, `md-editor` the editable document, `md-loading` the status shown
 * while the editor code loads, `md-error` a standalone load failure, `md-notice` a notice (the one-time "may
 * reformat" notice, or why a file is shown as source), `md-toolbar` the floating format toolbar,
 * `md-slash-menu` the block menu opened by `/` and `md-link-editor` the Cmd/Ctrl+K link dialog.
 *
 * @example
 * ```ts
 * MARKDOWN_PARTS.includes('md-editor'); // true
 * ```
 */
export const MARKDOWN_PARTS: readonly [
  'md-viewer',
  'md-error',
  'md-loading',
  'md-editor',
  'md-notice',
  'md-toolbar',
  'md-slash-menu',
  'md-link-editor',
] = [
  'md-viewer',
  'md-error',
  'md-loading',
  'md-editor',
  'md-notice',
  'md-toolbar',
  'md-slash-menu',
  'md-link-editor',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: MarkdownPart = 'md-editor';
 * ```
 */
export type MarkdownPart = (typeof MARKDOWN_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: MarkdownClassNames = { 'md-editor': 'prose' };
 * ```
 */
export type MarkdownClassNames = ClassNames<MarkdownPart>;
