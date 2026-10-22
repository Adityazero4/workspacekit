'use client';
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { partProps } from '../../cx';
import type { ClassNames } from '../../parts';
import { useLatest } from '../useLatest';

/**
 * One page as `renderPage` receives it. `width` and `height` are the page's size at zoom 1, as
 * `estimatePageSize` gave it; the page is drawn at `width × zoom` by `height × zoom` CSS px.
 *
 * @example
 * ```tsx
 * const renderPage = ({ index, zoom }: PageGeometry) => <img src={urlOf(index, zoom)} alt="" />;
 * ```
 */
export interface PageGeometry {
  index: number;
  width: number;
  height: number;
  zoom: number;
}

/**
 * What a `ref` on `VirtualPages` can do.
 *
 * @example
 * ```ts
 * pagesRef.current?.scrollToPage(0, { behavior: 'smooth' });
 * ```
 */
export interface VirtualPagesHandle {
  scrollToPage: (index: number, options?: { behavior?: ScrollBehavior }) => void;
}

/**
 * Props of `VirtualPages`. `estimatePageSize` returns a page's size in CSS px at zoom 1. `zoom` defaults to
 * 1, `gap` (between pages, and above the first and below the last) to 16 and `overscan` (pages kept mounted
 * beyond each edge of the viewport) to 1.
 *
 * @example
 * ```tsx
 * const props: VirtualPagesProps = {
 *   pageCount: 3,
 *   estimatePageSize: () => ({ width: 816, height: 1056 }),
 *   renderPage: ({ index }) => <img src={`/page-${index}.png`} alt="" />,
 *   'aria-label': 'report.tiff',
 * };
 * ```
 */
export interface VirtualPagesProps {
  pageCount: number;
  estimatePageSize: (index: number) => { width: number; height: number };
  renderPage: (page: PageGeometry) => ReactNode;
  zoom?: number;
  gap?: number;
  overscan?: number;
  initialPage?: number;
  onCurrentPageChange?: (index: number) => void;
  onPageMount?: (index: number) => void;
  onPageUnmount?: (index: number) => void;
  ref?: Ref<VirtualPagesHandle>;
  'aria-label': string;
  className?: string;
  classNames?: ClassNames;
}

const DEFAULT_GAP = 16;

type PageVirtualizer = Virtualizer<HTMLDivElement, Element>;

interface PageSizes {
  key: number;
  widest: number;
}

interface PageLayoutInputs {
  zoom: number;
  gap: number;
  estimatePageSize: VirtualPagesProps['estimatePageSize'];
  sizesKey: number;
}

interface MidpointPosition {
  index: number;
  fractionAboveMidpoint: number;
}

interface PageWindow {
  pages: VirtualItem[];
  totalSize: number;
  currentPageAt: (viewport: HTMLElement) => number;
  scrollToPage: VirtualPagesHandle['scrollToPage'];
}

function summarizePageSizes(
  pageCount: number,
  estimatePageSize: VirtualPagesProps['estimatePageSize'],
): PageSizes {
  let key = pageCount;
  let widest = 0;
  for (let index = 0; index < pageCount; index++) {
    const { width, height } = estimatePageSize(index);
    widest = Math.max(widest, width);
    key = (Math.imul(key, 31) + Math.round(width * 1024)) | 0;
    key = (Math.imul(key, 31) + Math.round(height * 1024)) | 0;
  }
  return { key, widest };
}

function positionAtMidpoint(virtualizer: PageVirtualizer, viewport: HTMLElement): MidpointPosition {
  const midpoint = viewport.scrollTop + viewport.clientHeight / 2;
  const page = virtualizer.getVirtualItemForOffset(midpoint);
  if (!page) return { index: 0, fractionAboveMidpoint: 0 };
  return {
    index: page.index,
    fractionAboveMidpoint: page.size > 0 ? (midpoint - page.start) / page.size : 0,
  };
}

function scrollTopKeeping(
  position: MidpointPosition,
  virtualizer: PageVirtualizer,
  viewportHeight: number,
): number {
  const totalSize = virtualizer.getTotalSize();
  const page = virtualizer.measurementsCache[position.index];
  if (!page) return 0;
  const midpoint = page.start + position.fractionAboveMidpoint * page.size;
  return Math.max(0, Math.min(midpoint - viewportHeight / 2, totalSize - viewportHeight));
}

function scrollTopShowingPage(index: number, inputs: PageLayoutInputs): number {
  let scrollTop = 0;
  for (let above = 0; above < index; above++) {
    scrollTop += inputs.estimatePageSize(above).height * inputs.zoom + inputs.gap;
  }
  return scrollTop;
}

function pagesOnScreen(range: Range, virtualizer: PageVirtualizer | undefined): Range {
  if (!virtualizer) return range;
  const top = virtualizer.scrollOffset ?? 0;
  const bottom = top + (virtualizer.scrollRect?.height ?? 0);
  const pages = virtualizer.measurementsCache;
  let { startIndex, endIndex } = range;
  while (startIndex < endIndex && pages[startIndex]!.end <= top) startIndex++;
  while (endIndex > startIndex && pages[endIndex]!.start >= bottom) endIndex--;
  return { ...range, startIndex, endIndex };
}

const isSameLayout = (previous: PageLayoutInputs, next: PageLayoutInputs): boolean =>
  previous.zoom === next.zoom && previous.gap === next.gap && previous.sizesKey === next.sizesKey;

function remeasureWindowingAround(viewport: HTMLElement, virtualizer: PageVirtualizer): number {
  const anchor = positionAtMidpoint(virtualizer, viewport);
  virtualizer.measure();
  const scrollTop = scrollTopKeeping(anchor, virtualizer, viewport.clientHeight);
  virtualizer.scrollOffset = scrollTop;
  return scrollTop;
}

function useAnchorAcrossLayoutChanges(
  virtualizer: PageVirtualizer,
  viewport: RefObject<HTMLDivElement | null>,
  inputs: PageLayoutInputs,
): void {
  const laidOutWith = useRef(inputs);
  const scrollTopToRestore = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (scrollTopToRestore.current !== null) {
      virtualizer.scrollToOffset(scrollTopToRestore.current);
      scrollTopToRestore.current = null;
    }
    const previous = laidOutWith.current;
    if (!viewport.current || isSameLayout(previous, inputs)) return;
    laidOutWith.current = inputs;
    scrollTopToRestore.current = remeasureWindowingAround(viewport.current, virtualizer);
  });
}

function usePageWindow(
  pageCount: number,
  inputs: PageLayoutInputs & { overscan: number; initialPage: number },
  viewport: RefObject<HTMLDivElement | null>,
): PageWindow {
  'use no memo';
  const { zoom, gap, estimatePageSize, sizesKey, overscan, initialPage } = inputs;
  const created: { virtualizer?: PageVirtualizer } = {};
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this hook uncompiled; it returns fresh values every render
  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => estimatePageSize(index).height * zoom,
    gap,
    overscan,
    paddingStart: gap,
    paddingEnd: gap,
    rangeExtractor: (range) => defaultRangeExtractor(pagesOnScreen(range, created.virtualizer)),
    scrollPaddingStart: gap,
    initialOffset: () => scrollTopShowingPage(Math.min(initialPage, pageCount - 1), inputs),
  });
  created.virtualizer = virtualizer;
  useAnchorAcrossLayoutChanges(virtualizer, viewport, { zoom, gap, estimatePageSize, sizesKey });
  return {
    pages: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    currentPageAt: (element) => positionAtMidpoint(virtualizer, element).index,
    scrollToPage: (index, options) =>
      virtualizer.scrollToIndex(index, { align: 'start', behavior: options?.behavior }),
  };
}

function useCurrentPageReporter(
  initialPage: number,
  onCurrentPageChange: ((index: number) => void) | undefined,
): (currentPage: number) => void {
  const reportedPage = useRef(initialPage);
  const notify = useLatest(onCurrentPageChange);
  return (currentPage) => {
    if (currentPage === reportedPage.current) return;
    reportedPage.current = currentPage;
    notify.current?.(currentPage);
  };
}

function useReportOnResize(
  viewport: RefObject<HTMLDivElement | null>,
  reportFrom: (viewport: HTMLElement) => void,
): void {
  const latestReport = useLatest(reportFrom);
  useLayoutEffect(() => {
    const target = viewport.current;
    if (!target) return undefined;
    const observer = new ResizeObserver(() => latestReport.current(target));
    observer.observe(target);
    return () => observer.disconnect();
  }, [viewport, latestReport]);
}

function pageForKey(key: string, currentPage: number, pageCount: number): number | undefined {
  switch (key) {
    case 'PageDown':
      return Math.min(currentPage + 1, pageCount - 1);
    case 'PageUp':
      return Math.max(currentPage - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return pageCount - 1;
    default:
      return undefined;
  }
}

function scrollToPageForKey(
  event: KeyboardEvent<HTMLDivElement>,
  pageWindow: PageWindow,
  pageCount: number,
): void {
  if (event.target !== event.currentTarget || pageCount === 0) return;
  const currentPage = pageWindow.currentPageAt(event.currentTarget);
  const target = pageForKey(event.key, currentPage, pageCount);
  if (target === undefined) return;
  event.preventDefault();
  pageWindow.scrollToPage(target);
}

interface PageLifecycle {
  mounted: (index: number) => void;
  unmounted: (index: number) => void;
}

function useStablePageLifecycle(
  onPageMount: ((index: number) => void) | undefined,
  onPageUnmount: ((index: number) => void) | undefined,
): PageLifecycle {
  const latest = useLatest({ onPageMount, onPageUnmount });
  const [lifecycle] = useState<PageLifecycle>(() => ({
    mounted: (index) => latest.current.onPageMount?.(index),
    unmounted: (index) => latest.current.onPageUnmount?.(index),
  }));
  return lifecycle;
}

interface PageProps {
  geometry: PageGeometry;
  top: number;
  lifecycle: PageLifecycle;
  classNames: ClassNames | undefined;
  children: ReactNode;
}

function Page(props: PageProps): React.JSX.Element {
  const { geometry, top, lifecycle, classNames, children } = props;
  const { index, width, height, zoom } = geometry;
  useEffect(() => {
    lifecycle.mounted(index);
    return () => lifecycle.unmounted(index);
  }, [index, lifecycle]);
  return (
    <div
      {...partProps('pages-page', classNames)}
      style={{ width: width * zoom, height: height * zoom, transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}

/**
 * A vertically scrolling, virtualized stack of pages (a multi-page TIFF, a PDF), centred horizontally and
 * scrolling sideways when a zoomed page is wider than the viewport. Only the pages on screen plus `overscan`
 * are mounted. `onPageMount` and `onPageUnmount` fire once per page lifetime, so a page's resources (a
 * decode, an object URL) can be allocated and released there; under `StrictMode` in development React runs
 * them as mount, unmount, mount, so keep them idempotent. The current page is the one under the viewport's
 * vertical midpoint; a zoom change keeps it, and the point of it under the midpoint, in place. The surface
 * (the `pages-viewport` part, which carries `data-zoomed` above zoom 1) is focusable: PageDown and PageUp go
 * to the next and previous page, Home and End to the first and last.
 *
 * @example
 * ```tsx
 * <VirtualPages
 *   pageCount={tiff.pages.length}
 *   estimatePageSize={(index) => tiff.pages[index]!}
 *   renderPage={({ index }) => <TiffPage index={index} />}
 *   zoom={zoom}
 *   onCurrentPageChange={setPage}
 *   aria-label="scan.tiff"
 * />
 * ```
 */
export function VirtualPages(props: VirtualPagesProps): React.JSX.Element {
  const { pageCount, estimatePageSize, renderPage, ref, className, classNames } = props;
  const zoom = props.zoom ?? 1;
  const initialPage = props.initialPage ?? 0;
  const viewport = useRef<HTMLDivElement>(null);
  const pageSizes = summarizePageSizes(pageCount, estimatePageSize);
  const gap = props.gap ?? DEFAULT_GAP;
  const overscan = props.overscan ?? 1;
  const pageWindow = usePageWindow(
    pageCount,
    { zoom, gap, estimatePageSize, sizesKey: pageSizes.key, overscan, initialPage },
    viewport,
  );
  const reportCurrentPage = useCurrentPageReporter(initialPage, props.onCurrentPageChange);
  const reportCurrentPageOf = (element: HTMLElement): void =>
    reportCurrentPage(pageWindow.currentPageAt(element));
  useReportOnResize(viewport, reportCurrentPageOf);
  const lifecycle = useStablePageLifecycle(props.onPageMount, props.onPageUnmount);
  useImperativeHandle(ref, () => ({ scrollToPage: pageWindow.scrollToPage }));
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a scrolling region takes focus so the keyboard can scroll it (WCAG 2.1.1); its page keys are handled here
    <div
      ref={viewport}
      {...partProps('pages-viewport', classNames, className)}
      role="region"
      aria-label={props['aria-label']}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region must be focusable to be scrolled by keyboard
      tabIndex={0}
      data-zoomed={zoom > 1 ? '' : undefined}
      onScroll={(event) => reportCurrentPageOf(event.currentTarget)}
      onKeyDown={(event) => scrollToPageForKey(event, pageWindow, pageCount)}
    >
      <div
        {...partProps('pages', classNames)}
        style={{ width: pageSizes.widest * zoom, height: pageWindow.totalSize }}
      >
        {pageWindow.pages.map(({ index, start }) => {
          const geometry = { index, ...estimatePageSize(index), zoom };
          return (
            <Page key={index} geometry={geometry} top={start} lifecycle={lifecycle} classNames={classNames}>
              {renderPage(geometry)}
            </Page>
          );
        })}
      </div>
    </div>
  );
}
