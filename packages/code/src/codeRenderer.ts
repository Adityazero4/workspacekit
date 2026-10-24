import {
  defineRenderer,
  MATCH_SCORE,
  type FileInfo,
  type Renderer,
  type RendererProps,
} from '@workspacekit/react/renderer-kit';
import { createElement } from 'react';
import { CODE_EXTENSIONS, hasAliasedBasename, MARKDOWN_EXTENSIONS } from './languages';
import type { CodeClassNames } from './parts';

/**
 * The largest file the code renderer and the standalone `CodeViewer` open: 10 MiB. A larger file is
 * `too_large` and is never read.
 *
 * @example
 * ```ts
 * useStandaloneBytes(src, onError, { maxBytes: CODE_MAX_BYTES });
 * ```
 */
export const CODE_MAX_BYTES: number = 10 * 1024 * 1024;

/**
 * Options of `codeRenderer`. `nonce` is set on the `<style>` elements CodeMirror adds, for a strict
 * `style-src` CSP. `classNames` adds classes to this package's parts (`code-viewer`, `code-editor`); the
 * viewer's own `classNames` only know `@workspacekit/react` parts.
 *
 * @example
 * ```ts
 * const options: CodeRendererOptions = { nonce, classNames: { 'code-editor': 'editor' } };
 * ```
 */
export interface CodeRendererOptions {
  nonce?: string;
  classNames?: CodeClassNames;
}

function matchScore(file: FileInfo): number | false {
  if (file.kind !== 'file') return false;
  if (CODE_EXTENSIONS.has(file.extension) || hasAliasedBasename(file.basename)) return MATCH_SCORE.specific;
  return MARKDOWN_EXTENSIONS.has(file.extension) && MATCH_SCORE.generic;
}

/**
 * Creates the registry entry for code, configuration and data files, up to 10 MiB, shown in an editable
 * CodeMirror 6 editor (read-only when the viewer says so). It scores `specific` for their extensions and for
 * names such as `Makefile`, `.env.*` and `.gitignore`, so it wins over the light text renderer; plain `.txt`
 * stays with the text renderer. Markdown scores only `generic`, so a Markdown renderer keeps `.md` files
 * and this one takes those it declines. CodeMirror loads when the viewer first shows such a file. `nonce` is
 * set on the `<style>` elements CodeMirror adds, for a strict `style-src` CSP. `classNames` adds classes to
 * this package's parts (`code-viewer`, `code-editor`); the viewer's own `classNames` only know
 * `@workspacekit/react` parts.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [codeRenderer({ nonce, classNames: { 'code-editor': 'editor' } }), ...lightRenderers];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function codeRenderer(options: CodeRendererOptions = {}): Renderer {
  const { nonce, classNames } = options;
  return defineRenderer({
    id: 'code',
    match: matchScore,
    load: async () => {
      const { CodeRenderer } = await import('./CodeMirrorEditor');
      return {
        default: (props: RendererProps) => createElement(CodeRenderer, { ...props, nonce, classNames }),
      };
    },
    input: 'text',
    maxBytes: CODE_MAX_BYTES,
    editable: true,
  });
}
