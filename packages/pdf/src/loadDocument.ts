import {
  getDocument,
  GlobalWorkerOptions,
  PixelsPerInch,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
import { EventBus, type PDFLinkService, type PDFPageView } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { createLinkService, type PageNavigation } from './linkService';
import type { PdfRendererOptions } from './pdfRenderer';
import { installPromiseWithResolvers, polyfilledWorkerUrl } from './promiseWithResolvers';

/**
 * A PDF to open: a URL (a string, or the viewer's `url` source with its `withCredentials`), a `Blob`, or the
 * file's bytes.
 *
 * @example
 * ```ts
 * const file: PdfFile = { url: 'https://files.example/a.pdf', withCredentials: true };
 * ```
 */
export type PdfFile = string | Blob | ArrayBuffer | Uint8Array | { url: string; withCredentials: boolean };

/**
 * What opening a PDF needs beyond the file: pdf.js's options, and the password to try first.
 *
 * @example
 * ```ts
 * const options: PdfEngineOptions = { password: 'open sesame', maxCanvasPixels: 8 * 1024 * 1024 };
 * ```
 */
export interface PdfEngineOptions extends Omit<PdfRendererOptions, 'classNames'> {
  password?: string;
}

/**
 * A page's size in CSS px at zoom 1, rotation and `UserUnit` included.
 *
 * @example
 * ```ts
 * const letter: PageSize = { width: 816, height: 1056 };
 * ```
 */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * A loaded document and the page sizes known so far, starting with the first page's.
 *
 * @example
 * ```ts
 * const { document, sizes } = await opened.loaded;
 * ```
 */
export interface LoadedDocument {
  document: PDFDocumentProxy;
  sizes: ReadonlyMap<number, PageSize>;
}

/**
 * One opened PDF and everything that must be torn down with it: the loading task (which owns the worker), the
 * event bus and link service its pages share, the page views drawn from it, and the object URL made for a
 * `Blob`.
 *
 * @example
 * ```ts
 * const opened = openDocument(file, options, navigation);
 * ```
 */
export interface OpenDocument {
  task: PDFDocumentLoadingTask;
  loaded: Promise<LoadedDocument>;
  eventBus: EventBus;
  linkService: PDFLinkService;
  views: Set<PDFPageView>;
  objectUrl: string | undefined;
}

const HUNDRED_MEGAPIXELS = 100_000_000;
const ignoreFailedTeardown = (): void => {};

const isHttpUrl = (url: string): boolean => {
  try {
    return /^https?:$/.test(new URL(url, document.baseURI).protocol);
  } catch {
    return false;
  }
};

/**
 * The CSS size of `page` at zoom 1, read from its viewport without drawing it.
 *
 * @example
 * ```ts
 * const size = pageSizeOf(await document.getPage(1));
 * ```
 */
export function pageSizeOf(page: PDFPageProxy): PageSize {
  const { width, height } = page.getViewport({ scale: PixelsPerInch.PDF_TO_CSS_UNITS });
  return { width, height };
}

/**
 * The `getDocument` parameters for `file`. Credentials are sent only to http and https URLs (pdf.js fails on
 * `blob:` and `data:` URLs with them). Bytes are copied, because pdf.js transfers and detaches the buffer it
 * is given. Images over 100 megapixels are not decoded (`maxImageSize`), which bounds the worker's memory for
 * a crafted image. A `Blob` gets an object URL (`objectUrl`; revoke it when done), so pdf.js reads it as a
 * stream.
 *
 * @example
 * ```ts
 * const { init } = documentInit({ url: 'https://files.example/a.pdf', withCredentials: true }, {});
 * ```
 */
export function documentInit(
  file: PdfFile,
  options: PdfEngineOptions,
): { init: DocumentInitParameters; objectUrl?: string } {
  const common: DocumentInitParameters = {
    ...options.assets,
    password: options.password,
    maxImageSize: HUNDRED_MEGAPIXELS,
  };
  if (typeof file === 'string') return { init: { ...common, url: file } };
  if (file instanceof Blob) {
    const objectUrl = URL.createObjectURL(file);
    return { init: { ...common, url: objectUrl }, objectUrl };
  }
  if ('url' in file) {
    return {
      init: { ...common, url: file.url, withCredentials: file.withCredentials && isHttpUrl(file.url) },
    };
  }
  return { init: { ...common, data: file.slice(0) } };
}

/**
 * The size in bytes of a PDF given as bytes or a blob; 0 for a URL, which pdf.js streams.
 *
 * @example
 * ```ts
 * if (byteSizeOf(file) > PDF_MAX_BYTES) onError(viewerError('too_large'));
 * ```
 */
export function byteSizeOf(file: PdfFile): number {
  if (typeof file === 'string' || 'url' in file) return 0;
  return file instanceof Blob ? file.size : file.byteLength;
}

/**
 * Starts opening `file` in its own pdf.js worker. `loaded` settles once the document and its first page's
 * size are known. Internal links and named actions move the page list through `navigation`. Close it with
 * `closeDocument`. Where the browser lacks `Promise.withResolvers`, it is installed first, here and in the
 * worker (see `polyfilledWorkerUrl`).
 *
 * @example
 * ```ts
 * const opened = openDocument(file, options, navigation);
 * ```
 */
export function openDocument(
  file: PdfFile,
  options: PdfEngineOptions,
  navigation: PageNavigation,
): OpenDocument {
  const workerSrc =
    options.workerSrc ?? new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
  GlobalWorkerOptions.workerSrc = installPromiseWithResolvers() ? polyfilledWorkerUrl(workerSrc) : workerSrc;
  const { init, objectUrl } = documentInit(file, options);
  const task = getDocument(init);
  const eventBus = new EventBus();
  const linkService = createLinkService(eventBus, navigation);
  const loaded = task.promise.then(async (document) => {
    linkService.setDocument(document);
    return { document, sizes: new Map([[0, pageSizeOf(await document.getPage(1))]]) };
  });
  return { task, loaded, eventBus, linkService, views: new Set(), objectUrl };
}

/**
 * Tears `opened` down in pdf.js's order: destroy every page view (pdf.js's `destroy` cancels its drawing and
 * cleans its page up), then destroy the loading task, which aborts its network requests and terminates its
 * worker. It does not wait for the worker, so it is safe in an effect cleanup, and it is safe to call twice
 * (as `StrictMode` does). Page views get no `abortSignal`: pdf.js would join it to the text layers' shared
 * selection listener with `AbortSignal.any`, so closing one document would drop that listener for the
 * documents still open.
 *
 * @example
 * ```ts
 * useEffect(() => () => closeDocument(opened), [opened]);
 * ```
 */
export function closeDocument(opened: OpenDocument): void {
  for (const view of opened.views) view.destroy();
  opened.views.clear();
  opened.task.destroy().catch(ignoreFailedTeardown);
  if (opened.objectUrl) URL.revokeObjectURL(opened.objectUrl);
}
