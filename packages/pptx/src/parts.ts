import type { ClassNames } from '@workspacekit/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with
 * the `pptx-` prefix. `pptx-viewer` is the root, `pptx-toolbar` holds the zoom buttons (`pptx-button`), the
 * zoom level and the "Slide X of N" indicator, and `pptx-status` announces them once they settle.
 * `pptx-slide` holds one slide (drawn in its shadow root), and `pptx-slide-error` takes its place when that
 * slide cannot be shown. `pptx-loading` says the presentation is opening, and `pptx-error` is the message
 * shown when a standalone file cannot be opened.
 *
 * @example
 * ```ts
 * PPTX_PARTS.includes('pptx-slide'); // true
 * ```
 */
export const PPTX_PARTS: readonly [
  'pptx-viewer',
  'pptx-error',
  'pptx-loading',
  'pptx-toolbar',
  'pptx-button',
  'pptx-zoom-level',
  'pptx-slide-indicator',
  'pptx-status',
  'pptx-slide',
  'pptx-slide-error',
] = [
  'pptx-viewer',
  'pptx-error',
  'pptx-loading',
  'pptx-toolbar',
  'pptx-button',
  'pptx-zoom-level',
  'pptx-slide-indicator',
  'pptx-status',
  'pptx-slide',
  'pptx-slide-error',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: PptxPart = 'pptx-slide';
 * ```
 */
export type PptxPart = (typeof PPTX_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: PptxClassNames = { 'pptx-toolbar': 'my-toolbar' };
 * ```
 */
export type PptxClassNames = ClassNames<PptxPart>;
