import { textRenderer } from '@scope/react';
import {
  defineRenderer,
  MATCH_SCORE,
  type FileInfo,
  type Renderer,
  type RendererProps,
} from '@scope/react/renderer-kit';
import { createElement, lazy } from 'react';
import { MarkdownRendererView } from './MarkdownView';
import type { MarkdownClassNames } from './parts';
import { RENDERED_VIEW_MAX_CHARACTERS } from './renderedView';

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mkd', 'mdown']);
const RENDERED_VIEW_MAX_BYTES = RENDERED_VIEW_MAX_CHARACTERS;

/**
 * The largest Markdown file the renderer reads: 10 MiB. A larger file is `too_large` and is never read. A
 * file over 500,000 bytes is declined before it is read, so the code renderer (or the text renderer) opens
 * it; one whose size is unknown is read and, if it is too long or too complex for the rendered view, shown
 * as source.
 *
 * @example
 * ```ts
 * const opens = file.size <= MARKDOWN_MAX_BYTES;
 * ```
 */
export const MARKDOWN_MAX_BYTES: number = 10 * 1024 * 1024;

function matchScore(file: FileInfo): number | false {
  if (file.kind !== 'file' || !MARKDOWN_EXTENSIONS.has(file.extension)) return false;
  return (file.size ?? 0) <= RENDERED_VIEW_MAX_BYTES && MATCH_SCORE.specific;
}

/**
 * Options of `markdownRenderer`. `source` is the renderer that draws source mode (the light text renderer
 * by default; pass `codeRenderer()` from `@scope/code` for highlighting). `classNames` adds classes to this
 * package's parts.
 *
 * @example
 * ```ts
 * const options: MarkdownRendererOptions = { source: codeRenderer(), classNames: { 'md-editor': 'prose' } };
 * ```
 */
export interface MarkdownRendererOptions {
  source?: Renderer;
  classNames?: MarkdownClassNames;
}

/**
 * Creates the registry entry for Markdown files (`.md`, `.markdown`, `.mkd`, `.mdown`): an editable
 * WYSIWYG view (Lexical, loaded when first shown) with a `source` mode. It declines files over 500,000
 * bytes, so the code renderer (or the text renderer) opens them; a text that turns out too large or too
 * complex for the rendered view is shown as source. Opening and closing a file without editing never
 * writes it; the first edit that would rewrite its Markdown shows a one-time notice. Links open in a new
 * tab and only for `http:`, `https:` and `mailto:`; images are links, never fetched; raw HTML stays text.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [markdownRenderer({ source: codeRenderer() }), codeRenderer(), ...lightRenderers];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function markdownRenderer(options: MarkdownRendererOptions = {}): Renderer {
  const { source = textRenderer, classNames } = options;
  const Source = lazy(source.load);
  return defineRenderer({
    id: 'markdown',
    match: matchScore,
    load: async () => {
      await import('./LexicalMarkdownEditor');
      return {
        default: (props: RendererProps) =>
          createElement(MarkdownRendererView, { ...props, markdownClassNames: classNames, Source }),
      };
    },
    input: 'text',
    maxBytes: MARKDOWN_MAX_BYTES,
    editable: true,
    modes: [
      { value: 'rendered', label: 'Rendered' },
      { value: 'source', label: 'Source' },
    ],
  });
}
