'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import { viewerError, type ViewerError } from '../../viewer/errors';
import type { RendererProps } from '../../viewer/registry';
import { VirtualPages } from '../pages/VirtualPages';
import { useStandaloneBytes, type StandaloneViewerProps } from '../standalone';
import { StandaloneRoot } from '../StandaloneRoot';
import { useLatest } from '../useLatest';
import { useSettledAnnouncement } from '../useSettledAnnouncement';
import { stepZoom, useElementSize } from '../zoom';
import type { TiffFile, TiffPageSize } from './decodeTiff';
import { createPageCache, type PageCache } from './pageCache';
import { TiffPageError } from './tiffPageError';

const PAGE_GAP = 16;
const MAX_ACQUIRE_ATTEMPTS = 2;
const MAX_LAID_OUT_SIDE = 32_767;
const NO_PAGE: TiffPageSize = { width: 0, height: 0 };

type Zoom = number | 'fit';
type TiffErrorHandler = (error: ViewerError, isStillShowingPages: boolean) => void;

interface ParsedTiff {
  file: TiffFile;
  cache: PageCache;
}

interface TiffViewProps {
  data: ArrayBuffer;
  name: string;
  onError: TiffErrorHandler;
  classNames: ClassNames | undefined;
}

function useParsedTiff(data: ArrayBuffer, onError: TiffErrorHandler): ParsedTiff | undefined {
  const [parsed, setParsed] = useState<ParsedTiff>();
  const reportError = useLatest(onError);
  const latestParsed = useLatest(parsed);
  useEffect(() => {
    let isCurrent = true;
    import('./decodeTiff')
      .then(({ parseTiff }) => parseTiff(data))
      .then(
        (file) => {
          if (isCurrent) setParsed({ file, cache: createPageCache(file.renderPage) });
        },
        (thrown: unknown) => {
          if (isCurrent) {
            reportError.current(viewerError('load_error', thrown), latestParsed.current !== undefined);
          }
        },
      );
    return () => {
      isCurrent = false;
    };
  }, [data, reportError, latestParsed]);
  useEffect(() => {
    if (!parsed) return;
    const { cache } = parsed;
    return () => cache.clear();
  }, [parsed]);
  return parsed;
}

const pageErrorOf = (thrown: unknown): ViewerError =>
  thrown instanceof TiffPageError ? viewerError(thrown.kind, thrown) : viewerError('load_error', thrown);

type ShownPage = { url: string } | { error: ViewerError } | undefined;

interface TiffPageProps {
  cache: PageCache;
  index: number;
  name: string;
  classNames: ClassNames | undefined;
}

function PageMessage(props: { error: ViewerError; classNames: ClassNames | undefined }): React.JSX.Element {
  'use no memo';
  return <p {...partProps('tiff-page-message', props.classNames)}>{props.error.message}</p>;
}

function DecodedPage(props: TiffPageProps): React.JSX.Element | null {
  const { cache, index, name, classNames } = props;
  const [shown, setShown] = useState<ShownPage>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let isCurrent = true;
    cache.acquire(index).then(
      (url) => {
        if (isCurrent) setShown({ url });
      },
      (thrown: unknown) => {
        if (isCurrent) setShown({ error: pageErrorOf(thrown) });
      },
    );
    return () => {
      isCurrent = false;
      cache.release(index);
    };
  }, [cache, index, attempt]);
  if (!shown) return null;
  if ('error' in shown) return <PageMessage error={shown.error} classNames={classNames} />;
  return (
    <img
      {...partProps('tiff-page-image', classNames)}
      src={shown.url}
      alt={`Page ${index + 1} of ${name}`}
      draggable={false}
      onError={() => {
        if (attempt < MAX_ACQUIRE_ATTEMPTS - 1) setAttempt(attempt + 1);
        else setShown({ error: viewerError('load_error') });
      }}
    />
  );
}

function TiffPage(props: TiffPageProps & { page: TiffPageSize | undefined }): React.JSX.Element {
  const { page, ...decoded } = props;
  if (page?.problem) return <PageMessage error={page.problem} classNames={decoded.classNames} />;
  return <DecodedPage {...decoded} />;
}

interface TiffToolbarProps {
  scale: number;
  onZoom: (zoom: Zoom) => void;
  currentPage: number;
  pageCount: number;
  classNames: ClassNames | undefined;
}

function TiffToolbar(props: TiffToolbarProps): React.JSX.Element {
  const { scale, onZoom, currentPage, pageCount, classNames } = props;
  const pageLabel = `Page ${currentPage + 1} of ${pageCount}`;
  const zoomLevel = `${Math.round(scale * 100)}%`;
  const pageAnnouncement = useSettledAnnouncement(pageLabel);
  const zoomAnnouncement = useSettledAnnouncement(`Zoom ${zoomLevel}`);
  const button = partProps('tiff-button', classNames);
  return (
    <div {...partProps('tiff-toolbar', classNames)}>
      <button type="button" {...button} aria-label="Zoom out" onClick={() => onZoom(stepZoom(scale, 'out'))}>
        −
      </button>
      <span {...partProps('tiff-zoom-level', classNames)}>{zoomLevel}</span>
      <span {...partProps('tiff-zoom-status', classNames)} role="status">
        {zoomAnnouncement}
      </span>
      <button type="button" {...button} aria-label="Zoom in" onClick={() => onZoom(stepZoom(scale, 'in'))}>
        +
      </button>
      <button type="button" {...button} onClick={() => onZoom('fit')}>
        Fit width
      </button>
      <span {...partProps('tiff-page-indicator', classNames)}>{pageLabel}</span>
      <span {...partProps('tiff-status', classNames)} role="status">
        {pageAnnouncement}
      </span>
    </div>
  );
}

const laidOutSize = (page: TiffPageSize | undefined): TiffPageSize => ({
  width: Math.min(page?.width ?? 0, MAX_LAID_OUT_SIDE),
  height: Math.min(page?.height ?? 0, MAX_LAID_OUT_SIDE),
});

function fitWidthScale(pages: readonly TiffPageSize[], availableWidth: number): number {
  const widest = pages.reduce((widest, page) => Math.max(widest, laidOutSize(page).width), 0);
  if (widest === 0 || availableWidth <= 0) return 1;
  return Math.min(1, Math.max(availableWidth - 2 * PAGE_GAP, 1) / widest);
}

const ZOOM_KEYS: Readonly<Record<string, (scale: number) => Zoom>> = {
  '+': (scale) => stepZoom(scale, 'in'),
  '=': (scale) => stepZoom(scale, 'in'),
  '-': (scale) => stepZoom(scale, 'out'),
  '0': () => 'fit',
};

function zoomOnKey(event: KeyboardEvent<HTMLElement>, scale: number, setZoom: (zoom: Zoom) => void): void {
  const zoomFor = ZOOM_KEYS[event.key];
  if (!zoomFor || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  setZoom(zoomFor(scale));
}

function TiffView(props: TiffViewProps): React.JSX.Element {
  const { data, name, onError, classNames } = props;
  const parsed = useParsedTiff(data, onError);
  const surface = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [currentPage, setCurrentPage] = useState(0);
  const availableWidth = useElementSize(surface).width;
  const pages = parsed?.file.pages ?? [];
  const scale = zoom === 'fit' ? fitWidthScale(pages, availableWidth) : zoom;
  return (
    <>
      {parsed && (
        <TiffToolbar
          scale={scale}
          onZoom={setZoom}
          currentPage={currentPage}
          pageCount={pages.length}
          classNames={classNames}
        />
      )}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- zoom keys bubble up from the focusable pages region inside; this wrapper is not itself interactive */}
      <div
        ref={surface}
        {...partProps('tiff-surface', classNames)}
        onKeyDown={(event) => zoomOnKey(event, scale, setZoom)}
      >
        {parsed && (
          <VirtualPages
            pageCount={pages.length}
            estimatePageSize={(index) => laidOutSize(pages[index] ?? NO_PAGE)}
            renderPage={({ index }) => (
              <TiffPage
                cache={parsed.cache}
                index={index}
                page={pages[index]}
                name={name}
                classNames={classNames}
              />
            )}
            zoom={scale}
            gap={PAGE_GAP}
            onCurrentPageChange={setCurrentPage}
            aria-label={name}
            classNames={classNames}
          />
        )}
      </div>
    </>
  );
}

/**
 * Shows a TIFF without a `FileSystemProvider`, one page under another. Page sizes come from the file's tags,
 * so the whole document is laid out before any pixels are decoded; each page is decoded when it scrolls
 * into view and kept as a PNG while it is on screen, and for the 8 most recently shown pages after that. A
 * page over its budget (100 megapixels, 32,767 px a side) shows "too large to preview" instead of being
 * decoded, and a page in a format the viewer cannot decode says so; crafted or corrupt files fail quickly
 * with an error instead of hanging. The toolbar, and the keys `+`, `-` and `0` on the pages, zoom in 0.25
 * steps from 0.1× to 8× and fit the widest page to the width (the start); the current page and the zoom
 * are announced once they settle. `src` is an http, https or blob URL, or the file's bytes; keep it stable
 * between renders (a new `src`, even with the same bytes, parses the file again). A new `src` keeps the page
 * and zoom; if it cannot be parsed, the pages shown stay under a notice that they are the previous version,
 * and the error goes to `onError`.
 *
 * @example
 * ```tsx
 * <TiffViewer src={file} fileName={file.name} />
 * ```
 */
export function TiffViewer(props: StandaloneViewerProps): React.JSX.Element {
  const { src, fileName, classNames, onError } = props;
  const { file, isLoadingNewSource } = useStandaloneBytes(src, onError);
  const [failure, setFailure] = useState<{ data: ArrayBuffer; error: ViewerError; isStale: boolean }>();
  const data = file.status === 'ready' ? file.data : undefined;
  const currentFailure = failure?.data === data ? failure : undefined;
  const state =
    currentFailure && !currentFailure.isStale
      ? { status: 'error' as const, error: currentFailure.error }
      : file;
  const reportError = (failed: ArrayBuffer, error: ViewerError, isStillShowingPages: boolean): void => {
    setFailure({ data: failed, error, isStale: isStillShowingPages });
    onError?.(error);
  };
  return (
    <StandaloneRoot
      part="tiff-viewer"
      errorPart="tiff-error"
      state={state}
      viewer={props}
      isLoadingNewSource={isLoadingNewSource}
      staleError={currentFailure?.isStale ? currentFailure.error : undefined}
    >
      {data && state.status === 'ready' && (
        <TiffView
          data={data}
          name={fileName ?? 'TIFF image'}
          onError={(error, isStillShowingPages) => reportError(data, error, isStillShowingPages)}
          classNames={classNames}
        />
      )}
    </StandaloneRoot>
  );
}

/**
 * The TIFF renderer component the registry loads: `TiffViewer`'s view for a viewer's `arrayBuffer` source.
 * A new version is parsed while the current one stays on screen, then its pages are decoded again, keeping
 * the page and zoom.
 *
 * @example
 * ```tsx
 * const { default: TiffRenderer } = await tiffRenderer.load();
 * ```
 */
export default function TiffRenderer(props: RendererProps): React.JSX.Element {
  const { entry, source, onError, className, classNames } = props;
  return (
    <div {...partProps('tiff-viewer', classNames, className)}>
      {source.kind === 'arrayBuffer' && (
        <TiffView
          data={source.data}
          name={entry.name}
          onError={(error) => onError(error)}
          classNames={classNames}
        />
      )}
    </div>
  );
}
