import { LinkTarget, PDFLinkService, type EventBus } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';

/**
 * How links move through the page list: `scrollToPage` and `currentPage` both use 0-based page indexes.
 *
 * @example
 * ```ts
 * const navigation: PageNavigation = {
 *   scrollToPage: (index) => pages.current?.scrollToPage(index),
 *   currentPage: () => 0,
 * };
 * ```
 */
export interface PageNavigation {
  scrollToPage: (index: number) => void;
  currentPage: () => number;
}

function viewerFor(navigation: PageNavigation): object {
  const goTo = (pageNumber: number): void => navigation.scrollToPage(pageNumber - 1);
  return {
    get currentPageNumber(): number {
      return navigation.currentPage() + 1;
    },
    set currentPageNumber(pageNumber: number) {
      goTo(pageNumber);
    },
    scrollPageIntoView: ({ pageNumber }: { pageNumber: number }) => goTo(pageNumber),
    nextPage: () => goTo(navigation.currentPage() + 2),
    previousPage: () => goTo(navigation.currentPage()),
  };
}

/**
 * pdf.js's link service for one document, wired to our page list. External links get `target="_blank"` and
 * `rel="noopener noreferrer"`; pdf.js renders only http, https, ftp, mailto and tel URLs, so `javascript:`
 * links never reach the DOM. Internal links (`goToPage`, and `goToDestination` once pdf.js has resolved a
 * named or explicit destination to its page) and the named actions `FirstPage`, `PrevPage`, `NextPage` and
 * `LastPage` go through pdf.js's viewer hooks, which here move the page list through `navigation`.
 *
 * @example
 * ```ts
 * const linkService = createLinkService(eventBus, navigation);
 * ```
 */
export function createLinkService(eventBus: EventBus, navigation: PageNavigation): PDFLinkService {
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer',
  });
  linkService.setViewer(viewerFor(navigation));
  return linkService;
}
