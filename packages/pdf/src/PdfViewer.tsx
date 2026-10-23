'use client';
import {
  partProps,
  StandaloneRoot,
  type StandaloneViewerProps,
  type ViewerError,
} from '@scope/react/renderer-kit';
import { lazy, Suspense, useState } from 'react';
import type { PdfClassNames, PdfPart } from './parts';
import type { PdfRendererOptions } from './pdfRenderer';

const PdfDocumentView = lazy(() => import('./PdfDocumentView'));
const SHOWN = { status: 'ready' } as const;

/**
 * Props of `PdfViewer`: the standalone viewer props, pdf.js's `workerSrc`, `assets` and `maxCanvasPixels`
 * (see `PdfRendererOptions`), and `password`, tried before the user is asked for one.
 *
 * @example
 * ```tsx
 * const props: PdfViewerProps = { src: '/files/report.pdf', fileName: 'report.pdf', theme: 'dark' };
 * ```
 */
export interface PdfViewerProps extends StandaloneViewerProps<PdfPart>, PdfRendererOptions {
  password?: string;
}

/**
 * The status shown while the PDF code, then the document, loads.
 *
 * @example
 * ```tsx
 * <Suspense fallback={<PdfLoading name="report.pdf" classNames={classNames} />} />
 * ```
 */
export function PdfLoading(props: {
  name: string;
  classNames: PdfClassNames | undefined;
}): React.JSX.Element {
  return (
    <p {...partProps('pdf-loading', props.classNames)} role="status">
      Opening {props.name}…
    </p>
  );
}

interface Failure {
  src: PdfViewerProps['src'];
  error: ViewerError;
  isStillShowingPages: boolean;
}

/**
 * Shows a PDF without a `FileSystemProvider`, drawn by pdf.js one page at a time as pages scroll into view,
 * with selectable text, safe links, zoom, "Page X of N" and a password prompt. `src` is a URL (streamed by
 * pdf.js, with range requests when the server allows them) or the file's bytes or blob, up to 200 MiB; the
 * bytes are copied, never detached. pdf.js loads on first render, so importing this is cheap. A new `src`
 * keeps the page and zoom; if it cannot be opened, the previous pages stay under a notice and the error goes
 * to `onError`. Cancelling the password prompt shows `password_protected`.
 *
 * @example
 * ```tsx
 * <PdfViewer src={file} fileName={file.name} assets={{ cMapUrl: '/pdfjs/cmaps/' }} />
 * ```
 */
export function PdfViewer(props: PdfViewerProps): React.JSX.Element {
  const { src, fileName, classNames, onError, workerSrc, assets, maxCanvasPixels, password } = props;
  const [failure, setFailure] = useState<Failure>();
  const currentFailure = failure?.src === src ? failure : undefined;
  const isFailed = currentFailure !== undefined && !currentFailure.isStillShowingPages;
  const name = fileName ?? 'PDF document';
  return (
    <StandaloneRoot
      part="pdf-viewer"
      errorPart="pdf-error"
      state={isFailed ? { status: 'error', error: currentFailure.error } : SHOWN}
      viewer={props}
      staleError={currentFailure?.isStillShowingPages ? currentFailure.error : undefined}
    >
      {!isFailed && (
        <Suspense fallback={<PdfLoading name={name} classNames={classNames} />}>
          <PdfDocumentView
            file={src}
            name={name}
            isActive
            options={{ workerSrc, assets, maxCanvasPixels, password }}
            classNames={classNames}
            onError={(error, isStillShowingPages) => {
              setFailure({ src, error, isStillShowingPages });
              onError?.(error);
            }}
          />
        </Suspense>
      )}
    </StandaloneRoot>
  );
}
