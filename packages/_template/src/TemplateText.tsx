'use client';
import { partProps } from '@workspacekit/react/renderer-kit';
import type { TemplateClassNames } from './parts';

/**
 * Props of `TemplateText`.
 *
 * @example
 * ```tsx
 * const props: TemplateTextProps = { text: 'hello' };
 * ```
 */
export interface TemplateTextProps {
  text: string;
  classNames?: TemplateClassNames;
}

/**
 * Draws a `.template` file's text. A real package imports its engine here, and only in this lazily loaded
 * module, so importing the package's entry never loads the engine.
 *
 * @example
 * ```tsx
 * const TemplateText = lazy(() => import('./TemplateText'));
 * ```
 */
export default function TemplateText({ text, classNames }: TemplateTextProps): React.JSX.Element {
  return <pre {...partProps('template-text', classNames)}>{text}</pre>;
}
