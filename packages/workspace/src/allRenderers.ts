import { codeRenderer, type CodeRendererOptions } from '@workspacekit/code';
import { docxRenderer, type DocxRendererOptions } from '@workspacekit/docx';
import { markdownRenderer, type MarkdownRendererOptions } from '@workspacekit/markdown';
import { pdfRenderer, type PdfRendererOptions } from '@workspacekit/pdf';
import { pptxRenderer, type PptxRendererOptions } from '@workspacekit/pptx';
import { lightRenderers, type Renderer } from '@workspacekit/react';
import { spreadsheetRenderer, type SpreadsheetRendererOptions } from '@workspacekit/spreadsheet';

/**
 * Options of `allRenderers`, one entry per renderer package, each passed to that package's factory as it is:
 * `pdf` to `pdfRenderer` (such as `workerSrc` and `assets`), `spreadsheet` to `spreadsheetRenderer` (such as
 * `engines.xlsx`), `code` to `codeRenderer` (such as the CSP `nonce`), and so on. Markdown's source mode is
 * always drawn by that same code renderer.
 *
 * @example
 * ```ts
 * const options: AllRenderersOptions = {
 *   pdf: { workerSrc: '/pdfjs/pdf.worker.min.mjs' },
 *   spreadsheet: { engines: { xlsx: () => import('xlsx') } },
 *   code: { nonce },
 * };
 * ```
 */
export interface AllRenderersOptions {
  pdf?: PdfRendererOptions;
  docx?: DocxRendererOptions;
  pptx?: PptxRendererOptions;
  spreadsheet?: SpreadsheetRendererOptions;
  markdown?: Omit<MarkdownRendererOptions, 'source'>;
  code?: CodeRendererOptions;
}

/**
 * Every renderer the library ships, in precedence order: PDF, Word, PowerPoint, spreadsheets, Markdown
 * (its source mode drawn by the code renderer), code, then the built-in light renderers (text, HTML, image,
 * TIFF, audio, video, directory and the unsupported fallback). A heavy renderer scores higher than the
 * light text and image ones for its own file kinds, so it wins; where scores tie, the earlier entry wins,
 * which is why Markdown comes before code. Nothing here loads an engine: each renderer imports its engine
 * the first time a file of its kind opens. `options` reach each package's factory (see
 * `AllRenderersOptions`), so the order never has to be rebuilt by hand.
 *
 * Call it once, at module level, and reuse the result: the viewer caches each renderer's loaded component by
 * the renderer object's identity.
 *
 * @example
 * ```tsx
 * const renderers = [myCsvRenderer, ...allRenderers({ pdf: { workerSrc }, code: { nonce } })];
 *
 * export function App({ adapter }: { adapter: FileSystemAdapter }): React.JSX.Element {
 *   return <Workspace adapter={adapter} renderers={renderers} />;
 * }
 * ```
 */
export function allRenderers(options: AllRenderersOptions = {}): Renderer[] {
  const code = codeRenderer(options.code);
  return [
    pdfRenderer(options.pdf),
    docxRenderer(options.docx),
    pptxRenderer(options.pptx),
    spreadsheetRenderer(options.spreadsheet),
    markdownRenderer({ ...options.markdown, source: code }),
    code,
    ...lightRenderers,
  ];
}
