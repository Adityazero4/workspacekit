'use client';
import type { SlideHandle } from '@aiden0z/pptx-renderer';
import {
  partProps,
  stepZoom,
  useSettledAnnouncement,
  viewerError,
  VirtualPages,
  type RendererProps,
  type ViewerError,
  type VirtualPagesHandle,
} from '@workspacekit/react/renderer-kit';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { DocumentLimitExceeded, EncryptedPresentation } from './limits';
import type { PptxClassNames } from './parts';
import type { PptxRendererOptions } from './pptxRenderer';
import { PptxLoading } from './PptxViewer';
import {
  canShowSlide,
  closePresentation,
  hideSlide,
  openPresentation,
  showSlide,
  type OpenedPresentation,
} from './slides';

/**
 * Props of `PptxDocument`.
 *
 * @example
 * ```tsx
 * const props: PptxDocumentProps = { data, name: 'deck.pptx', classNames: undefined, onError: report };
 * ```
 */
export interface PptxDocumentProps extends PptxRendererOptions {
  data: ArrayBuffer;
  name: string;
  classNames: PptxClassNames | undefined;
  onError: (error: ViewerError) => void;
}

function errorOf(thrown: unknown): ViewerError {
  if (thrown instanceof EncryptedPresentation) return viewerError('password_protected', thrown);
  return viewerError(thrown instanceof DocumentLimitExceeded ? 'too_large' : 'load_error', thrown);
}

function useShownPresentation(
  props: PptxDocumentProps,
  goToSlide: (index: number) => void,
): OpenedPresentation | undefined {
  const { data } = props;
  const [shown, setShown] = useState<OpenedPresentation>();
  const reportError = useEffectEvent((thrown: unknown) => props.onError(errorOf(thrown)));
  const slideOptions = useEffectEvent(() => ({ externalMedia: props.externalMedia ?? 'block', goToSlide }));
  useEffect(() => {
    const controller = new AbortController();
    openPresentation(data, controller.signal, slideOptions()).then(
      (opened) => (controller.signal.aborted ? closePresentation(opened) : setShown(opened)),
      (thrown: unknown) => {
        if (!controller.signal.aborted) reportError(thrown);
      },
    );
    return () => controller.abort();
  }, [data]);
  useEffect(() => {
    if (shown) return () => closePresentation(shown);
  }, [shown]);
  return shown;
}

interface PptxSlideProps {
  opened: OpenedPresentation;
  index: number;
  slideCount: number;
  width: number;
  height: number;
  zoom: number;
  settledZoom: string;
  classNames: PptxClassNames | undefined;
  onDrawError: (thrown: unknown) => void;
}

function PptxSlide(props: PptxSlideProps): React.JSX.Element {
  'use no memo';
  const { opened, index, slideCount, width, height, zoom, settledZoom, classNames } = props;
  const host = useRef<HTMLDivElement>(null);
  const reportDrawError = useEffectEvent(props.onDrawError);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let handle: SlideHandle;
    try {
      handle = showSlide(element, opened, index);
    } catch (thrown) {
      reportDrawError(thrown);
      return;
    }
    return () => hideSlide(element, handle);
  }, [opened, index, settledZoom]);
  const name = `Slide ${index + 1} of ${slideCount}`;
  if (!canShowSlide(opened, index)) {
    return <p {...partProps('pptx-slide-error', classNames)}>{`${name} is too large to show.`}</p>;
  }
  return (
    <div
      ref={host}
      {...partProps('pptx-slide', classNames)}
      role="group"
      aria-label={name}
      style={{ width, height, transform: `scale(${zoom})` }}
    />
  );
}

interface PptxToolbarProps {
  name: string;
  zoom: number;
  onZoom: (zoom: number) => void;
  currentSlide: number;
  slideCount: number;
  classNames: PptxClassNames | undefined;
}

function PptxToolbar(props: PptxToolbarProps): React.JSX.Element {
  const { name, zoom, onZoom, currentSlide, slideCount, classNames } = props;
  const slideLabel = `Slide ${currentSlide + 1} of ${slideCount}`;
  const zoomLevel = `${Math.round(zoom * 100)}%`;
  const button = partProps('pptx-button', classNames);
  const announcement = useSettledAnnouncement(`${slideLabel}, zoom ${zoomLevel}`);
  return (
    <div {...partProps('pptx-toolbar', classNames)} role="toolbar" aria-label={`${name} controls`}>
      <button {...button} type="button" aria-label="Zoom out" onClick={() => onZoom(stepZoom(zoom, 'out'))}>
        −
      </button>
      <span {...partProps('pptx-zoom-level', classNames)}>{zoomLevel}</span>
      <button {...button} type="button" aria-label="Zoom in" onClick={() => onZoom(stepZoom(zoom, 'in'))}>
        +
      </button>
      <span {...partProps('pptx-slide-indicator', classNames)}>{slideLabel}</span>
      <span {...partProps('pptx-status', classNames)} role="status">
        {announcement}
      </span>
    </div>
  );
}

/**
 * A presentation's slides in a `VirtualPages` list, with the zoom toolbar. Only slides near the viewport
 * are drawn, each from an effect, and disposed when it scrolls away. A zoom scales the drawn slides with CSS
 * at once, and redraws them at the new zoom once it has settled, so they are not left blurred. A new `data`
 * opens beside the shown presentation and replaces it once opened, keeping the slide and zoom; the replaced
 * one, and on unmount the shown one, is closed (its charts disposed, its media URLs revoked). An open
 * overtaken by a newer `data`, or by unmount, is never shown.
 *
 * @example
 * ```tsx
 * <PptxDocument data={buffer} name="deck.pptx" classNames={undefined} onError={report} />
 * ```
 */
export default function PptxDocument(props: PptxDocumentProps): React.JSX.Element {
  const { name, classNames } = props;
  const pages = useRef<VirtualPagesHandle>(null);
  const shown = useShownPresentation(props, (index) => pages.current?.scrollToPage(index));
  const [zoom, setZoom] = useState(1);
  const [currentSlide, setCurrentSlide] = useState(0);
  const settledZoom = useSettledAnnouncement(String(zoom));
  if (!shown) return <PptxLoading name={name} classNames={classNames} />;
  const { presentation } = shown;
  const slideCount = presentation.slides.length;
  return (
    <>
      <PptxToolbar
        name={name}
        zoom={zoom}
        onZoom={setZoom}
        currentSlide={Math.min(currentSlide, slideCount - 1)}
        slideCount={slideCount}
        classNames={classNames}
      />
      <VirtualPages
        ref={pages}
        pageCount={slideCount}
        estimatePageSize={() => presentation}
        renderPage={(page) => (
          <PptxSlide
            opened={shown}
            index={page.index}
            slideCount={slideCount}
            width={page.width}
            height={page.height}
            zoom={page.zoom}
            settledZoom={settledZoom}
            classNames={classNames}
            onDrawError={(thrown) => props.onError(errorOf(thrown))}
          />
        )}
        zoom={zoom}
        initialPage={currentSlide}
        onCurrentPageChange={setCurrentSlide}
        aria-label={name}
      />
    </>
  );
}

/**
 * Props of `PptxRenderer`: the registry's renderer props, with this package's `classNames` and the
 * options from `pptxRenderer(options)`.
 *
 * @example
 * ```tsx
 * const props: PptxRendererProps = { ...rendererProps, classNames: { 'pptx-viewer': 'viewer' } };
 * ```
 */
export interface PptxRendererProps extends Omit<RendererProps, 'classNames'>, PptxRendererOptions {}

/**
 * The registry's component for `.pptx` files: the `pptx-viewer` root around `PptxDocument`. A failure goes
 * to the viewer's `onError`, which keeps an earlier version on screen under a banner.
 *
 * @example
 * ```tsx
 * <PptxRenderer {...rendererProps} classNames={{ 'pptx-slide': 'slide' }} />
 * ```
 */
export function PptxRenderer(props: PptxRendererProps): React.JSX.Element {
  'use no memo';
  const { entry, source, onError, className, classNames, externalMedia } = props;
  return (
    <div {...partProps('pptx-viewer', classNames, className)}>
      {source.kind === 'arrayBuffer' && (
        <PptxDocument
          data={source.data}
          name={entry.name}
          externalMedia={externalMedia}
          classNames={classNames}
          onError={onError}
        />
      )}
    </div>
  );
}
