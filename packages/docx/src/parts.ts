import type { ClassNames } from '@workspacekit/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with
 * the `docx-` prefix. `docx-viewer` is the root, `docx-document` is the scrolling element that holds the
 * rendered document (in its shadow root), `docx-loading` says the document is opening, and `docx-error` is
 * the message shown when a standalone file cannot be opened.
 *
 * @example
 * ```ts
 * DOCX_PARTS.includes('docx-document'); // true
 * ```
 */
export const DOCX_PARTS: readonly ['docx-viewer', 'docx-error', 'docx-loading', 'docx-document'] = [
  'docx-viewer',
  'docx-error',
  'docx-loading',
  'docx-document',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: DocxPart = 'docx-document';
 * ```
 */
export type DocxPart = (typeof DOCX_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: DocxClassNames = { 'docx-document': 'my-document' };
 * ```
 */
export type DocxClassNames = ClassNames<DocxPart>;
