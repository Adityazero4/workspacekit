import { defineRenderer, MATCH_SCORE, type Renderer, type RendererProps } from '@scope/react/renderer-kit';
import { createElement } from 'react';
import type { TemplateClassNames } from './parts';

export { TemplateViewer } from './TemplateViewer';
export { TEMPLATE_PARTS } from './parts';
export type { TemplateClassNames, TemplatePart } from './parts';

/**
 * Options of `templateRenderer`. `classNames` adds classes to this package's parts; the viewer's own
 * `classNames` only know `@scope/react` parts.
 *
 * @example
 * ```ts
 * const options: TemplateRendererOptions = { classNames: { 'template-text': 'text' } };
 * ```
 */
export interface TemplateRendererOptions {
  classNames?: TemplateClassNames;
}

/**
 * Creates the registry entry for `.template` files. Its component, and the engine it imports, load only
 * when the viewer first shows such a file. Call it once, at module level, and reuse the result: the viewer
 * caches each renderer's loaded component by the renderer object's identity, so a renderer created during
 * render loads its code again and remounts on every render.
 *
 * @example
 * ```tsx
 * const renderers = [...lightRenderers, templateRenderer({ classNames: { 'template-text': 'text' } })];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function templateRenderer(options: TemplateRendererOptions = {}): Renderer {
  const { classNames } = options;
  return defineRenderer({
    id: 'template',
    match: (file) => file.extension === 'template' && MATCH_SCORE.specific,
    load: async () => {
      const { default: TemplateRenderer } = await import('./TemplateRenderer');
      return { default: (props: RendererProps) => createElement(TemplateRenderer, { ...props, classNames }) };
    },
    input: 'text',
    maxBytes: 1024 * 1024,
  });
}
