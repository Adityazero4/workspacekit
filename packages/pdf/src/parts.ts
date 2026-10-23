import type { ClassNames } from '@scope/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with
 * the `pdf-` prefix. `pdf-viewer` is the root, `pdf-toolbar` holds the zoom buttons (`pdf-button`), the
 * zoom level and the "Page X of N" indicator, and `pdf-status` announces them once they settle. `pdf-page`
 * holds one page drawn by pdf.js, and `pdf-page-error` covers it when that page cannot be shown.
 * `pdf-password` is the password form, with its `pdf-password-label`, `pdf-password-input` and the
 * `pdf-password-error` shown after a wrong password. `pdf-loading` says the document is opening, and
 * `pdf-error` is the message shown when a standalone file cannot be opened.
 *
 * @example
 * ```ts
 * PDF_PARTS.includes('pdf-page'); // true
 * ```
 */
export const PDF_PARTS: readonly [
  'pdf-viewer',
  'pdf-error',
  'pdf-loading',
  'pdf-toolbar',
  'pdf-button',
  'pdf-zoom-level',
  'pdf-page-indicator',
  'pdf-status',
  'pdf-page',
  'pdf-page-error',
  'pdf-password',
  'pdf-password-label',
  'pdf-password-input',
  'pdf-password-error',
] = [
  'pdf-viewer',
  'pdf-error',
  'pdf-loading',
  'pdf-toolbar',
  'pdf-button',
  'pdf-zoom-level',
  'pdf-page-indicator',
  'pdf-status',
  'pdf-page',
  'pdf-page-error',
  'pdf-password',
  'pdf-password-label',
  'pdf-password-input',
  'pdf-password-error',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: PdfPart = 'pdf-page';
 * ```
 */
export type PdfPart = (typeof PDF_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: PdfClassNames = { 'pdf-toolbar': 'my-toolbar' };
 * ```
 */
export type PdfClassNames = ClassNames<PdfPart>;
