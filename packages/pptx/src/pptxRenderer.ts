import {
  defineRenderer,
  MATCH_SCORE,
  type FileInfo,
  type Renderer,
  type RendererProps,
} from '@workspacekit/react/renderer-kit';
import { createElement } from 'react';
import type { PptxClassNames } from './parts';

/**
 * The largest `.pptx` the renderer and the standalone `PptxViewer` open: 200 MiB. A larger file is
 * `too_large` and is never read.
 *
 * @example
 * ```ts
 * useStandaloneBytes(src, onError, { maxBytes: PPTX_MAX_BYTES });
 * ```
 */
export const PPTX_MAX_BYTES: number = 200 * 1024 * 1024;

/**
 * Options of `pptxRenderer` and `PptxViewer`. `externalMedia` is `'block'` by default: pictures, fills and
 * video posters a presentation links from outside the file are not fetched. `'allow'` lets the renderer
 * fetch them over `http(s):`. `classNames` adds classes to this package's parts; the viewer's own
 * `classNames` only know `@workspacekit/react` parts.
 *
 * @example
 * ```ts
 * const options: PptxRendererOptions = { externalMedia: 'allow', classNames: { 'pptx-slide': 'slide' } };
 * ```
 */
export interface PptxRendererOptions {
  externalMedia?: 'block' | 'allow';
  classNames?: PptxClassNames;
}

const matchScore = (file: FileInfo): number | false =>
  file.kind === 'file' && file.extension === 'pptx' && MATCH_SCORE.specific;

/**
 * Creates the registry entry for PowerPoint `.pptx` files up to 200 MiB: slides in a virtualized list
 * (only the slides near the viewport are drawn), with zoom and a "Slide X of N" toolbar. Each slide is drawn
 * by `@aiden0z/pptx-renderer` into its own shadow root and checked before it is shown: links are only
 * `http(s):` and `mailto:` (opened in a new tab), nothing is drawn outside the slide's box, and nothing
 * outside the file is fetched unless `externalMedia` is `'allow'`. A file whose archive, slide count or
 * size would cost too much work is `too_large`, and an encrypted one is `password_protected`; a single slide
 * that would cost too much to draw is replaced by a notice. The
 * renderer (with ECharts, about 384 KB gzipped) loads when the viewer first shows such a file. `classNames`
 * adds classes to this package's parts; the viewer's own `classNames` only know `@workspacekit/react` parts.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [pptxRenderer({ classNames: { 'pptx-slide': 'slide' } }), ...lightRenderers];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function pptxRenderer(options: PptxRendererOptions = {}): Renderer {
  const { externalMedia, classNames } = options;
  return defineRenderer({
    id: 'pptx',
    match: matchScore,
    load: async () => {
      const { PptxRenderer } = await import('./PptxDocument');
      return {
        default: (props: RendererProps) =>
          createElement(PptxRenderer, { ...props, externalMedia, classNames }),
      };
    },
    input: 'arrayBuffer',
    maxBytes: PPTX_MAX_BYTES,
  });
}
