import type { ClassNames } from '@workspacekit/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with the
 * package's `template-` prefix.
 *
 * @example
 * ```ts
 * TEMPLATE_PARTS.includes('template-text'); // true
 * ```
 */
export const TEMPLATE_PARTS: readonly ['template-viewer', 'template-error', 'template-text'] = [
  'template-viewer',
  'template-error',
  'template-text',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: TemplatePart = 'template-text';
 * ```
 */
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: TemplateClassNames = { 'template-text': 'my-text' };
 * ```
 */
export type TemplateClassNames = ClassNames<TemplatePart>;
