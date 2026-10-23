import { defineRenderer, MATCH_SCORE, type Renderer, type RendererProps } from '@scope/react/renderer-kit';
import { createElement } from 'react';
import type { PdfClassNames } from './parts';

/**
 * The largest PDF the renderer and the standalone `PdfViewer` open from bytes or a blob: 200 MiB. A larger
 * file is `too_large` and is never parsed. A URL that pdf.js streams (with range requests) is not gated.
 *
 * @example
 * ```ts
 * const opens = file.size <= PDF_MAX_BYTES;
 * ```
 */
export const PDF_MAX_BYTES: number = 200 * 1024 * 1024;

/**
 * Where pdf.js finds the data files it cannot reach through `import.meta.url`: `wasmUrl` (the JPX and JBIG2
 * image decoders), `cMapUrl` (character maps for CJK text) and `standardFontDataUrl` (the 14 standard fonts
 * when a PDF does not embed them). Each is a directory URL with a trailing slash, served from your origin at
 * the pinned pdf.js version, for instance a copy of `node_modules/pdfjs-dist/{wasm,cmaps,standard_fonts}/`.
 * Without them, JPX and JBIG2 images are missing and non-embedded CJK fonts draw with fallback glyphs.
 *
 * @example
 * ```ts
 * const assets: PdfAssets = {
 *   wasmUrl: '/pdfjs/wasm/',
 *   cMapUrl: '/pdfjs/cmaps/',
 *   standardFontDataUrl: '/pdfjs/standard_fonts/',
 * };
 * ```
 */
export interface PdfAssets {
  wasmUrl?: string;
  cMapUrl?: string;
  standardFontDataUrl?: string;
}

/**
 * How pdf.js runs. `workerSrc` replaces the worker's URL, which by default is `new
 * URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url)` and so must be resolved by your
 * bundler; it must be the same pdf.js version (6.4.299) and the legacy build too. A worker on another
 * origin, and any worker in a browser without `Promise.withResolvers` (before Chrome 119 or Safari 17.4,
 * where it starts from a `blob:` wrapper that installs it), needs `worker-src blob:` in your CSP. `assets`
 * locates pdf.js's data files. The `blob:` wrapper is chosen by testing the page's `Promise.withResolvers`,
 * and a worker has its own globals: if your app polyfills it on the page (with core-js, for example), the
 * wrapper is skipped and the worker still lacks it on Chrome 105 to 118 and Safari 15.4 to 17.3. On those
 * browsers pass a `workerSrc` that is your own module worker, which installs the polyfill and then imports
 * `pdfjs-dist/legacy/build/pdf.worker.min.mjs`. `maxCanvasPixels` caps each page's canvas (default 16
 * megapixels); above it pages are zoomed with CSS, which keeps memory bounded with many tabs open.
 * `classNames` adds classes to this package's parts; the viewer's own `classNames` only know `@scope/react`
 * parts.
 *
 * @example
 * ```ts
 * const options: PdfRendererOptions = { workerSrc: '/pdfjs/pdf.worker.min.mjs', maxCanvasPixels: 8_388_608 };
 * ```
 */
export interface PdfRendererOptions {
  workerSrc?: string;
  assets?: PdfAssets;
  maxCanvasPixels?: number;
  classNames?: PdfClassNames;
}

/**
 * Creates the registry entry for `.pdf` files up to 200 MiB, drawn by pdf.js (6.4.299, its legacy build,
 * which runs in the browsers this library supports) one page at a time as pages scroll into view, with
 * selectable text, links (external ones open in a new tab with `rel="noopener noreferrer"`; `javascript:`
 * links are never rendered), zoom, "Page X of N" and a password prompt. It takes the file as a URL: the
 * adapter's `url` when it has one (streamed with range requests, with credentials only over http and https),
 * an object URL of the file otherwise. pdf.js loads when the viewer first shows a PDF.
 *
 * The worker is found with `new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url)`. Vite
 * resolves that in a build, but not inside a dependency it pre-bundles in development (`import.meta.url` then
 * points into `.vite/deps`): add `optimizeDeps: { exclude: ['@scope/pdf'] }` to your Vite config, or pass
 * `workerSrc` (for example `import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'`).
 * `classNames` adds classes to this package's parts; the viewer's own `classNames` only know `@scope/react`
 * parts.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [pdfRenderer({ classNames: { 'pdf-toolbar': 'toolbar' } }), ...lightRenderers];
 *
 * export function App({ path }: { path: string }): React.JSX.Element {
 *   return <FileViewer path={path} renderers={renderers} />;
 * }
 * ```
 */
export function pdfRenderer(options: PdfRendererOptions = {}): Renderer {
  return defineRenderer({
    id: 'pdf',
    match: (file) => file.kind === 'file' && file.extension === 'pdf' && MATCH_SCORE.specific,
    load: async () => {
      const { PdfRenderer } = await import('./PdfDocumentView');
      return {
        default: (props: RendererProps) =>
          createElement(PdfRenderer, { ...props, ...options, classNames: options.classNames }),
      };
    },
    input: 'url',
    maxBytes: PDF_MAX_BYTES,
  });
}
