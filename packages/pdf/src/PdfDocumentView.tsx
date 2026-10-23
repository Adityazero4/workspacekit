'use client';
import {
  partProps,
  stepZoom,
  useSettledAnnouncement,
  VirtualPages,
  type RendererProps,
  type ViewerError,
  type VirtualPagesHandle,
} from '@scope/react/renderer-kit';
import { useRef, useState } from 'react';
import type { PageNavigation } from './linkService';
import type { PdfEngineOptions, PdfFile } from './loadDocument';
import type { PdfClassNames } from './parts';
import { PasswordPrompt } from './PasswordPrompt';
import { PdfPage } from './PdfPage';
import type { PdfRendererOptions } from './pdfRenderer';
import { PdfLoading } from './PdfViewer';
import { useShownDocument } from './useShownDocument';

/**
 * Props of `PdfDocumentView`. `onError` also says whether pages of an earlier version are still shown.
 *
 * @example
 * ```tsx
 * const props: PdfDocumentViewProps = {
 *   file,
 *   name: 'a.pdf',
 *   isActive: true,
 *   options: {},
 *   classNames,
 *   onError,
 * };
 * ```
 */
export interface PdfDocumentViewProps {
  file: PdfFile;
  name: string;
  isActive: boolean;
  options: PdfEngineOptions;
  classNames: PdfClassNames | undefined;
  onError: (error: ViewerError, isStillShowingPages: boolean) => void;
}

interface PdfToolbarProps {
  name: string;
  zoom: number;
  onZoom: (zoom: number) => void;
  currentPage: number;
  pageCount: number;
  classNames: PdfClassNames | undefined;
}

function PdfToolbar(props: PdfToolbarProps): React.JSX.Element {
  const { name, zoom, onZoom, currentPage, pageCount, classNames } = props;
  const pageLabel = `Page ${currentPage + 1} of ${pageCount}`;
  const zoomLevel = `${Math.round(zoom * 100)}%`;
  const button = partProps('pdf-button', classNames);
  const announcement = useSettledAnnouncement(`${pageLabel}, zoom ${zoomLevel}`);
  return (
    <div {...partProps('pdf-toolbar', classNames)} role="toolbar" aria-label={`${name} controls`}>
      <button {...button} type="button" aria-label="Zoom out" onClick={() => onZoom(stepZoom(zoom, 'out'))}>
        −
      </button>
      <span {...partProps('pdf-zoom-level', classNames)}>{zoomLevel}</span>
      <button {...button} type="button" aria-label="Zoom in" onClick={() => onZoom(stepZoom(zoom, 'in'))}>
        +
      </button>
      <span {...partProps('pdf-page-indicator', classNames)}>{pageLabel}</span>
      <span {...partProps('pdf-status', classNames)} role="status">
        {announcement}
      </span>
    </div>
  );
}

/**
 * A PDF's pages in a `VirtualPages` list, with the toolbar and the password prompt (after which the pages
 * come back at the page they were on). The document opens in
 * its own pdf.js worker; a new `file` opens beside it and replaces it once loaded, keeping the page and zoom,
 * and the old one is then closed. Page sizes start from the first page's and are read for each page as it
 * comes near the viewport, so a 10,000-page document opens with a handful of worker round trips.
 *
 * @example
 * ```tsx
 * <PdfDocumentView file={src} name="a.pdf" isActive options={{}} classNames={undefined} onError={report} />
 * ```
 */
export default function PdfDocumentView(props: PdfDocumentViewProps): React.JSX.Element {
  const { name, isActive, options, classNames } = props;
  const pages = useRef<VirtualPagesHandle>(null);
  const currentPageNow = useRef(0);
  const navigation: PageNavigation = {
    scrollToPage: (index) => pages.current?.scrollToPage(index),
    currentPage: () => currentPageNow.current,
  };
  const { shown, password, learnPageSize } = useShownDocument(props, navigation);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(0);
  const showPage = (index: number): void => {
    currentPageNow.current = index;
    setCurrentPage(index);
  };
  if (password) return <PasswordPrompt name={name} request={password} classNames={classNames} />;
  if (!shown) return <PdfLoading name={name} classNames={classNames} />;
  const { opened, document, sizes } = shown;
  const firstPageSize = sizes.get(0)!;
  return (
    <>
      <PdfToolbar
        name={name}
        zoom={zoom}
        onZoom={setZoom}
        currentPage={currentPage}
        pageCount={document.numPages}
        classNames={classNames}
      />
      <VirtualPages
        ref={pages}
        pageCount={document.numPages}
        estimatePageSize={(index) => sizes.get(index) ?? firstPageSize}
        renderPage={(page) => (
          <PdfPage
            opened={opened}
            document={document}
            index={page.index}
            zoom={page.zoom}
            isActive={isActive}
            maxCanvasPixels={options.maxCanvasPixels}
            classNames={classNames}
          />
        )}
        zoom={zoom}
        initialPage={currentPage}
        onCurrentPageChange={showPage}
        onPageMount={learnPageSize}
        aria-label={name}
      />
    </>
  );
}

/**
 * Props of `PdfRenderer`: the viewer's renderer props, with `classNames` for this package's parts and the
 * pdf.js options from `pdfRenderer(options)`.
 *
 * @example
 * ```ts
 * const props: PdfRendererProps = { ...rendererProps, classNames: { 'pdf-page': 'my-page' } };
 * ```
 */
export interface PdfRendererProps extends Omit<RendererProps, 'classNames'>, PdfRendererOptions {}

/**
 * The component `pdfRenderer()` loads for the viewer: the document view for the viewer's `url` source. A new
 * version opens in place, keeping the page and zoom; one that cannot be opened is reported and the previous
 * pages stay.
 *
 * @example
 * ```tsx
 * <PdfRenderer {...rendererProps} workerSrc="/pdfjs/pdf.worker.min.mjs" />
 * ```
 */
export function PdfRenderer(props: PdfRendererProps): React.JSX.Element {
  const { entry, source, isActive, onError, className, classNames, workerSrc, assets, maxCanvasPixels } =
    props;
  return (
    <div {...partProps('pdf-viewer', classNames, className)}>
      {source.kind === 'url' && (
        <PdfDocumentView
          file={source}
          name={entry.name}
          isActive={isActive}
          options={{ workerSrc, assets, maxCanvasPixels }}
          classNames={classNames}
          onError={(error) => onError(error)}
        />
      )}
    </div>
  );
}
