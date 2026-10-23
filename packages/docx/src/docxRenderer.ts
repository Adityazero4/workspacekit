import {
  defineRenderer,
  MATCH_SCORE,
  type FileInfo,
  type Renderer,
  type RendererProps,
} from '@scope/react/renderer-kit';
import { createElement } from 'react';
import type { DocxClassNames } from './parts';

/**
 * The largest `.docx` the renderer and the standalone `DocxViewer` open: 25 MiB. docx-preview renders the
 * whole document at once, so a larger file is `too_large` and is never read.
 *
 * @example
 * ```ts
 * useStandaloneBytes(src, onError, { maxBytes: DOCX_MAX_BYTES });
 * ```
 */
export const DOCX_MAX_BYTES: number = 25 * 1024 * 1024;

/**
 * Options of `docxRenderer`. `classNames` adds classes to this package's parts; the viewer's own `classNames`
 * only know `@scope/react` parts.
 *
 * @example
 * ```ts
 * const options: DocxRendererOptions = { classNames: { 'docx-document': 'pages' } };
 * ```
 */
export interface DocxRendererOptions {
  classNames?: DocxClassNames;
}

const matchScore = (file: FileInfo): number | false =>
  file.kind === 'file' && file.extension === 'docx' && MATCH_SCORE.specific;

/**
 * Creates the registry entry for Word `.docx` files up to 25 MiB, laid out in pages by docx-preview and
 * sanitized before it is shown: no scripts, frames or embedded HTML, only `http(s):` and `mailto:` links
 * (opened in a new tab), `#bookmark` links that scroll inside the document, no request for anything
 * outside the file, and nothing drawn outside the viewer's box. A document whose unzipped size, XML,
 * relationships or element count would cost too much work to show is `too_large`. The document lives in a
 * shadow root, so its styles and ids never touch the app. docx-preview, DOMPurify and fflate load when the
 * viewer first shows such a file. Legacy Word 97–2003
 * `.doc` files do not match, so they fall through to the unsupported view. `classNames` adds classes to
 * this package's parts; the viewer's own `classNames` only know `@scope/react` parts.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [docxRenderer({ classNames: { 'docx-document': 'pages' } }), ...lightRenderers];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function docxRenderer(options: DocxRendererOptions = {}): Renderer {
  const { classNames } = options;
  return defineRenderer({
    id: 'docx',
    match: matchScore,
    load: async () => {
      const { DocxRenderer } = await import('./DocxDocument');
      return { default: (props: RendererProps) => createElement(DocxRenderer, { ...props, classNames }) };
    },
    input: 'arrayBuffer',
    maxBytes: DOCX_MAX_BYTES,
  });
}
