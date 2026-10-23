'use client';
import type { RendererProps } from '@scope/react/renderer-kit';
import TemplateText from './TemplateText';
import type { TemplateClassNames } from './parts';

/**
 * Props of `TemplateRenderer`: what the viewer hands every renderer, with the `classNames` that
 * `templateRenderer()` was given.
 *
 * @example
 * ```tsx
 * const props: TemplateRendererProps = { ...rendererProps, classNames: { 'template-text': 'text' } };
 * ```
 */
export interface TemplateRendererProps extends Omit<RendererProps, 'classNames'> {
  classNames?: TemplateClassNames;
}

/**
 * The registry component `templateRenderer()` loads: shows the text source the viewer hands it.
 *
 * @example
 * ```tsx
 * const load = () => import('./TemplateRenderer');
 * ```
 */
export default function TemplateRenderer({ source, classNames }: TemplateRendererProps): React.JSX.Element {
  return <TemplateText text={source.kind === 'text' ? source.text : ''} classNames={classNames} />;
}
