import type { ClassNames } from '@scope/react/renderer-kit';

/**
 * Every element this package renders carries `data-fs-part="<part>"`; these are its part names, all with the
 * `code-` prefix. `code-viewer` is the root, `code-editor` holds CodeMirror, `code-loading` is the status
 * shown while the editor code loads, and `code-error` is the message shown when a standalone file fails to
 * load.
 *
 * @example
 * ```ts
 * CODE_PARTS.includes('code-editor'); // true
 * ```
 */
export const CODE_PARTS: readonly ['code-viewer', 'code-error', 'code-editor', 'code-loading'] = [
  'code-viewer',
  'code-error',
  'code-editor',
  'code-loading',
];

/**
 * A part name of this package.
 *
 * @example
 * ```ts
 * const part: CodePart = 'code-editor';
 * ```
 */
export type CodePart = (typeof CODE_PARTS)[number];

/**
 * Extra class names per part of this package, merged after the part's own class.
 *
 * @example
 * ```ts
 * const classNames: CodeClassNames = { 'code-editor': 'my-editor' };
 * ```
 */
export type CodeClassNames = ClassNames<CodePart>;
