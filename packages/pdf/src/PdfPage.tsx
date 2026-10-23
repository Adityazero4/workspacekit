'use client';
import { partProps } from '@scope/react/renderer-kit';
import {
  AnnotationMode,
  RenderingCancelledException,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFPageView, RenderingStates } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { OpenDocument } from './loadDocument';
import type { PdfClassNames } from './parts';

const TEXT_LAYER_ENABLED = 1;
const SIXTEEN_MEGAPIXELS = 4096 * 4096;

/**
 * Props of `PdfPage`: the opened document (whose event bus and link service the page shares),
 * the 0-based page `index`, the zoom (1 is 100%), and whether the viewer is shown.
 *
 * @example
 * ```tsx
 * const props: PdfPageProps = { opened, document, index: 0, zoom: 1, isActive: true, classNames: undefined };
 * ```
 */
export interface PdfPageProps {
  opened: OpenDocument;
  document: PDFDocumentProxy;
  index: number;
  zoom: number;
  isActive: boolean;
  maxCanvasPixels?: number;
  classNames: PdfClassNames | undefined;
}

function createPageView(container: HTMLDivElement, page: PDFPageProxy, props: PdfPageProps): PDFPageView {
  const view = new PDFPageView({
    container,
    id: props.index + 1,
    scale: props.zoom,
    defaultViewport: page.getViewport({ scale: 1 }),
    eventBus: props.opened.eventBus,
    textLayerMode: TEXT_LAYER_ENABLED,
    annotationMode: AnnotationMode.ENABLE,
    layerProperties: { linkService: props.opened.linkService },
    maxCanvasPixels: props.maxCanvasPixels ?? SIXTEEN_MEGAPIXELS,
  });
  view.setPdfPage(page);
  props.opened.views.add(view);
  return view;
}

function drawAt(
  view: PDFPageView,
  zoom: number,
  isActive: boolean,
  onFailure: (error: unknown) => void,
): void {
  if (view.scale !== zoom) view.update({ scale: zoom });
  if (!isActive) {
    view.cancelRendering();
    return;
  }
  if (view.renderingState === RenderingStates.FINISHED) return;
  if (view.renderingState !== RenderingStates.INITIAL) view.reset();
  view.draw().catch((error: unknown) => {
    if (!(error instanceof RenderingCancelledException)) onFailure(error);
  });
}

interface FailedPage {
  document: PDFDocumentProxy;
  index: number;
}

/**
 * One page, drawn by pdf.js's `PDFPageView` with its canvas, selectable text layer and link layer. The view
 * is created once the page is fetched, redrawn at a new zoom, stopped while `isActive` is false, and
 * destroyed (which cancels its drawing and cleans its page up) when the page scrolls away or the document
 * changes. A page that cannot be fetched or drawn gets `data-status="error"` and says so; a cancelled
 * drawing is not a failure.
 *
 * @example
 * ```tsx
 * <PdfPage opened={opened} document={document} index={index} zoom={zoom} isActive classNames={classNames} />
 * ```
 */
export function PdfPage(props: PdfPageProps): React.JSX.Element {
  const { opened, document, index, zoom, isActive, classNames } = props;
  const slot = useRef<HTMLDivElement>(null);
  const shownView = useRef<PDFPageView>(undefined);
  const [failedPage, setFailedPage] = useState<FailedPage>();
  const isFailed = failedPage?.document === document && failedPage.index === index;
  const failedWhileShown = (view: PDFPageView | undefined) => () => {
    if (shownView.current === view) setFailedPage({ document, index });
  };
  const createAndDraw = useEffectEvent((container: HTMLDivElement, page: PDFPageProxy) => {
    const view = createPageView(container, page, props);
    shownView.current = view;
    drawAt(view, zoom, isActive, failedWhileShown(view));
    return view;
  });
  const failToFetch = useEffectEvent(failedWhileShown(undefined));
  useEffect(() => {
    let isMounted = true;
    let view: PDFPageView | undefined;
    document.getPage(index + 1).then(
      (page) => {
        if (isMounted && slot.current) view = createAndDraw(slot.current, page);
      },
      () => {
        if (isMounted) failToFetch();
      },
    );
    return () => {
      isMounted = false;
      shownView.current = undefined;
      if (!view) return;
      opened.views.delete(view);
      view.destroy();
      view.div.remove();
    };
  }, [opened, document, index]);
  const redraw = useEffectEvent((view: PDFPageView) => drawAt(view, zoom, isActive, failedWhileShown(view)));
  useEffect(() => {
    if (shownView.current) redraw(shownView.current);
  }, [zoom, isActive]);
  return (
    <div ref={slot} {...partProps('pdf-page', classNames)} data-status={isFailed ? 'error' : undefined}>
      {isFailed && (
        <p {...partProps('pdf-page-error', classNames)}>{`Page ${index + 1} couldn't be shown.`}</p>
      )}
    </div>
  );
}
