import type { ViewerError } from '@workspacekit/react/renderer-kit';
import '@workspacekit/react/styles.css';
import axe from 'axe-core';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '../dist/styles.css';
import { PdfViewer } from '../src';
import { RenderingCancelledException } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFPageView } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { closeDocument, documentInit, openDocument } from '../src/loadDocument';
import { PdfRenderer, type PdfRendererProps } from '../src/PdfDocumentView';
import { PdfPage } from '../src/PdfPage';
import { blankPages, pdfBytes, type FixturePage } from './fixtures/pdf';
import { trackWorkers, workerTraffic } from './support/trackedWorkers';

const CSS_PX_PER_POINT = 96 / 72;
const PAGE_GAP = 16;
const LETTER_HEIGHT_PX = 792 * CSS_PX_PER_POINT;
const PASSWORD_PROTECTED_COPY =
  "This file is password-protected and can't be previewed. Download it to open it.";
const SLOW_PDF_WORK = { timeout: 15_000 };

beforeAll(() => trackWorkers());

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(0);
});

const part = <T extends Element = HTMLElement>(name: string): T | null =>
  document.querySelector<T>(`[data-fs-part=${name}]`);
const parts = (name: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(`[data-fs-part=${name}]`),
];
const pageIndicator = (): string | null | undefined => part('pdf-page-indicator')?.textContent;
const zoomLevel = (): string | null | undefined => part('pdf-zoom-level')?.textContent;
const viewport = (): HTMLElement => part('pages-viewport')!;
const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  )!;
const textLayerText = (): string =>
  [...document.querySelectorAll('.textLayer')].map((layer) => layer.textContent).join('|');
const drawnCanvases = (): number => document.querySelectorAll('.canvasWrapper canvas').length;

const sized = (children: ReactNode, height = 600): React.JSX.Element => (
  <div style={{ width: 1200, height, display: 'flex', flexDirection: 'column' }}>{children}</div>
);

const scrollToPage = async (index: number, pageCount: number): Promise<void> => {
  viewport().scrollTop = PAGE_GAP + index * (LETTER_HEIGHT_PX + PAGE_GAP);
  await expect.poll(pageIndicator).toBe(`Page ${index + 1} of ${pageCount}`);
};

const blobUrlOf = (bytes: Uint8Array): string =>
  URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/pdf' }));

const rendererProps = (url: string, version: number): PdfRendererProps => ({
  entry: { path: 'docs/report.pdf', name: 'report.pdf', kind: 'file' },
  source: { kind: 'url', url, withCredentials: false },
  version,
  mode: undefined,
  isActive: true,
  readOnly: true,
  onError: () => {},
});

test('page sizes come from the viewports: each page is laid out at its own size and rotation', async () => {
  const pages: FixturePage[] = [{}, { width: 792, height: 612 }, { width: 300, height: 400 }];
  await render(sized(<PdfViewer src={pdfBytes({ pages })} fileName="mixed.pdf" />, 3000));
  const laidOut = (): number[][] =>
    parts('pages-page').map((page) =>
      [page.style.width, page.style.height].map((side) => Math.round(parseFloat(side))),
    );
  await expect.poll(laidOut, SLOW_PDF_WORK).toEqual([
    [816, 1056],
    [1056, 816],
    [400, Math.round(400 * CSS_PX_PER_POINT)],
  ]);
});

test('only the pages near the viewport mount, and a 10,000-page PDF opens with bounded work', async () => {
  const before = workerTraffic.getPageRequests;
  await render(sized(<PdfViewer src={pdfBytes({ pages: blankPages(10_000) })} fileName="huge.pdf" />));
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 1 of 10000');
  await expect.poll(drawnCanvases, SLOW_PDF_WORK).toBeGreaterThan(0);
  expect(parts('pdf-page').length).toBeLessThanOrEqual(3);
  expect(workerTraffic.getPageRequests - before).toBeGreaterThan(0);
  expect(workerTraffic.getPageRequests - before).toBeLessThanOrEqual(4);
  viewport().focus();
  await userEvent.keyboard('{End}');
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 10000 of 10000');
  await expect
    .poll(() => document.querySelector('.page[data-page-number="10000"]'), SLOW_PDF_WORK)
    .not.toBeNull();
  expect(parts('pdf-page').length).toBeLessThanOrEqual(3);
  expect(workerTraffic.getPageRequests - before).toBeLessThanOrEqual(8);
});

const linkedPdf = (): Uint8Array =>
  pdfBytes({
    pages: [
      {
        text: 'Hello PDF',
        links: [
          { rect: [72, 600, 300, 640], uri: 'https://example.com/' },
          { rect: [72, 500, 300, 540], uri: 'javascript:alert(1)' },
          { rect: [72, 400, 300, 440], toPage: 29 },
        ],
      },
      ...blankPages(39),
    ],
  });

test('text is selectable; external links open safely; javascript: links never render; internal links scroll', async () => {
  await render(sized(<PdfViewer src={linkedPdf()} fileName="links.pdf" />));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Hello PDF');
  const textLayer = document.querySelector<HTMLElement>('.textLayer')!;
  expect(getComputedStyle(textLayer).position).toBe('absolute');
  expect(getComputedStyle(textLayer.querySelector('span')!).color).toBe('rgba(0, 0, 0, 0)');
  getSelection()!.selectAllChildren(textLayer);
  expect(getSelection()!.toString()).toContain('Hello PDF');
  getSelection()!.removeAllRanges();

  await expect.poll(() => document.querySelectorAll('.annotationLayer a').length, SLOW_PDF_WORK).toBe(2);
  const external = document.querySelector<HTMLAnchorElement>('.annotationLayer a[href^="https:"]')!;
  expect([external.href, external.target, external.rel]).toEqual([
    'https://example.com/',
    '_blank',
    'noopener noreferrer',
  ]);
  expect(document.querySelector('a[href^="javascript:" i], [href*="alert(1)"]')).toBeNull();

  document.querySelector<HTMLAnchorElement>('.annotationLayer a[href^="#"]')!.click();
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 30 of 40');
});

const numberedPages = (label: string): FixturePage[] =>
  Array.from({ length: 40 }, (_, index) => ({ text: `${label} page ${index + 1}` }));

test('zoom keeps the page; a refresh keeps page and zoom', async () => {
  const first = blobUrlOf(pdfBytes({ pages: numberedPages('First') }));
  const screen = await render(sized(<PdfRenderer {...rendererProps(first, 1)} />));
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 1 of 40');
  await scrollToPage(9, 40);
  await userEvent.click(button('Zoom in'));
  await expect.poll(zoomLevel).toBe('125%');
  await expect.poll(pageIndicator).toBe('Page 10 of 40');
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('First page 10');

  const second = blobUrlOf(pdfBytes({ pages: numberedPages('Second') }));
  await screen.rerender(sized(<PdfRenderer {...rendererProps(second, 2)} />));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Second page 10');
  expect(textLayerText()).not.toContain('First');
  expect([pageIndicator(), zoomLevel()]).toEqual(['Page 10 of 40', '125%']);
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(1);
  URL.revokeObjectURL(first);
  URL.revokeObjectURL(second);
});

const SECRET = pdfBytes({ pages: [{ text: 'Secret text' }], password: 'open sesame' });

test('password prompt: correct, incorrect, cancel', async () => {
  await render(sized(<PdfViewer src={SECRET} fileName="secret.pdf" />));
  await expect.poll(() => part('pdf-password-input'), SLOW_PDF_WORK).not.toBeNull();
  const input = part<HTMLInputElement>('pdf-password-input')!;
  expect(input.labels?.[0]?.textContent).toBe('Password for secret.pdf');
  await expect.poll(() => document.activeElement).toBe(input);
  expect((await axe.run(part('pdf-password')!)).violations).toEqual([]);

  await userEvent.type(input, 'wrong');
  await userEvent.click(button('Submit'));
  await expect.poll(() => part('pdf-password-error')?.textContent, SLOW_PDF_WORK).toBe('Incorrect password');
  expect(part('pdf-password-error')!.getAttribute('role')).toBe('alert');
  expect([input.value, input.getAttribute('aria-invalid')]).toEqual(['', 'true']);
  await expect.poll(() => document.activeElement).toBe(input);

  await userEvent.type(input, 'open sesame');
  await userEvent.click(button('Submit'));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Secret text');
  expect(part('pdf-password')).toBeNull();
});

test('password prompt: cancel shows password_protected; a password prop opens without a prompt', async () => {
  const errors: ViewerError[] = [];
  const screen = await render(
    sized(<PdfViewer src={SECRET} fileName="secret.pdf" onError={(error) => errors.push(error)} />),
  );
  await expect.poll(() => part('pdf-password'), SLOW_PDF_WORK).not.toBeNull();
  await userEvent.click(button('Cancel'));
  await expect.poll(() => part('pdf-error')?.textContent).toBe(PASSWORD_PROTECTED_COPY);
  expect(errors.map((error) => error.kind)).toEqual(['password_protected']);
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(0);

  await screen.rerender(
    sized(<PdfViewer src={SECRET.slice()} fileName="secret.pdf" password="open sesame" />),
  );
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Secret text');
  expect(part('pdf-password')).toBeNull();
});

test('unmount and file switch destroy the loading task; no leaked workers across 20 opens', async () => {
  const screen = await render(
    <StrictMode>
      {sized(<PdfViewer src={pdfBytes({ pages: [{ text: 'Open 0' }] })} fileName="0.pdf" />)}
    </StrictMode>,
  );
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Open 0');
  const startedBefore = workerTraffic.started;
  for (let open = 1; open <= 20; open++) {
    await screen.rerender(
      <StrictMode>
        {sized(<PdfViewer src={pdfBytes({ pages: [{ text: `Open ${open}` }] })} fileName={`${open}.pdf`} />)}
      </StrictMode>,
    );
    if (open % 5 === 0) await expect.poll(textLayerText, SLOW_PDF_WORK).toContain(`Open ${open}`);
  }
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Open 20');
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(1);
  expect(workerTraffic.started - startedBefore).toBeGreaterThanOrEqual(20);
  expect(new Set(workerTraffic.urls.map((url) => new URL(url).pathname.split('/').at(-1)))).toEqual(
    new Set(['pdf.worker.min.mjs']),
  );
  screen.unmount();
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(0);

  const midLoad = await render(
    sized(<PdfViewer src={pdfBytes({ pages: blankPages(2000) })} fileName="big.pdf" />),
  );
  midLoad.unmount();
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(0);
});

test('withCredentials only for http(s); blob and data sources work', async () => {
  const credentialsFor = (url: string): boolean | undefined =>
    documentInit({ url, withCredentials: true }, {}).init.withCredentials;
  expect(credentialsFor('https://files.example/a.pdf')).toBe(true);
  expect(credentialsFor('/api/files/a.pdf')).toBe(true);
  expect(credentialsFor('blob:https://app.example/1234')).toBe(false);
  expect(credentialsFor('data:application/pdf;base64,JVBERi0=')).toBe(false);
  expect(
    documentInit({ url: 'https://files.example/a.pdf', withCredentials: false }, {}).init.withCredentials,
  ).toBe(false);

  const bytes = pdfBytes({ pages: [{ text: 'From bytes' }] });
  const screen = await render(sized(<PdfViewer src={bytes} fileName="bytes.pdf" />));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('From bytes');
  expect(bytes.byteLength).toBeGreaterThan(0);
  await screen.rerender(sized(<PdfViewer src={bytes.buffer as ArrayBuffer} fileName="buffer.pdf" />));
  await expect.poll(() => parts('pdf-page').length, SLOW_PDF_WORK).toBe(1);
  expect(bytes.buffer.byteLength).toBeGreaterThan(0);
  await screen.rerender(
    sized(<PdfViewer src={new Blob([pdfBytes({ pages: [{ text: 'From a blob' }] })])} fileName="blob.pdf" />),
  );
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('From a blob');
  const dataUrl = `data:application/pdf;base64,${btoa(String.fromCharCode(...pdfBytes({ pages: [{ text: 'From a data URL' }] })))}`;
  await screen.rerender(sized(<PdfViewer src={dataUrl} fileName="data.pdf" />));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('From a data URL');
});

test('isActive=false cancels rendering, and drawing resumes when it is true again', async () => {
  const url = blobUrlOf(pdfBytes({ pages: numberedPages('Hidden') }));
  const props = rendererProps(url, 1);
  const draws = vi.spyOn(PDFPageView.prototype, 'draw');
  const screen = await render(sized(<PdfRenderer {...props} isActive={false} />));
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 1 of 40');
  await expect.poll(() => document.querySelectorAll('.page').length, SLOW_PDF_WORK).toBeGreaterThan(0);
  expect(draws).not.toHaveBeenCalled();
  expect(drawnCanvases()).toBe(0);
  await screen.rerender(sized(<PdfRenderer {...props} isActive />));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Hidden page 1');
  expect(draws).toHaveBeenCalled();
  URL.revokeObjectURL(url);
});

test('a corrupt file is a load_error passed to onError', async () => {
  const onError = vi.fn<(error: ViewerError) => void>();
  const props: PdfRendererProps = {
    ...rendererProps(blobUrlOf(new TextEncoder().encode('not a pdf')), 1),
    onError,
  };
  await render(sized(<PdfRenderer {...props} />));
  await expect
    .poll(() => onError.mock.calls.map(([error]) => error.kind), SLOW_PDF_WORK)
    .toEqual(['load_error']);
});

test('a page that cannot be fetched or drawn says so; a cancelled drawing is not a failure', async () => {
  const pages: FixturePage[] = [{ text: 'Cancelled' }, { text: 'Fails to draw' }, { unreadable: true }];
  const draw = PDFPageView.prototype.draw;
  vi.spyOn(PDFPageView.prototype, 'draw').mockImplementation(function (this: PDFPageView) {
    if (this.id === 1) return Promise.reject(new RenderingCancelledException('cancelled'));
    if (this.id === 2) return Promise.reject(new Error('the page is broken'));
    return draw.call(this);
  });
  await render(sized(<PdfViewer src={pdfBytes({ pages })} fileName="broken.pdf" />, 4000));
  const failedPages = (): (string | null | undefined)[] =>
    parts('pdf-page')
      .filter((page) => page.dataset.status === 'error')
      .map((page) => page.querySelector('[data-fs-part=pdf-page-error]')?.textContent);
  await expect
    .poll(failedPages, SLOW_PDF_WORK)
    .toEqual(["Page 2 couldn't be shown.", "Page 3 couldn't be shown."]);
  expect(parts('pdf-page')).toHaveLength(3);
});

const namedActionLinks: FixturePage['links'] = [
  { rect: [72, 700, 300, 740], named: 'FirstPage' },
  { rect: [72, 600, 300, 640], named: 'PrevPage' },
  { rect: [72, 500, 300, 540], named: 'NextPage' },
  { rect: [72, 400, 300, 440], named: 'LastPage' },
];

test('named actions: FirstPage, PrevPage, NextPage and LastPage move through the pages', async () => {
  const pages = Array.from({ length: 20 }, () => ({ links: namedActionLinks }));
  await render(sized(<PdfViewer src={pdfBytes({ pages })} fileName="actions.pdf" />));
  const clickOnPage = async (pageNumber: number, action: number): Promise<void> => {
    const layer = `.page[data-page-number="${pageNumber}"] .annotationLayer a`;
    await expect.poll(() => document.querySelectorAll(layer).length, SLOW_PDF_WORK).toBe(4);
    const links = [...document.querySelectorAll<HTMLAnchorElement>(layer)].sort(
      (first, second) => first.getBoundingClientRect().top - second.getBoundingClientRect().top,
    );
    links[action]!.click();
  };
  await clickOnPage(1, 3);
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 20 of 20');
  await clickOnPage(20, 1);
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 19 of 20');
  await clickOnPage(19, 0);
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 1 of 20');
  await clickOnPage(1, 2);
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 2 of 20');
});

test('closing a document destroys its page views and empties opened.views', async () => {
  const opened = openDocument(
    pdfBytes({ pages: [{ text: 'Owned view' }] }),
    {},
    {
      scrollToPage: () => {},
      currentPage: () => 0,
    },
  );
  const { document } = await opened.loaded;
  const screen = await render(
    sized(<PdfPage opened={opened} document={document} index={0} zoom={1} isActive classNames={undefined} />),
  );
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Owned view');
  const [view] = opened.views;
  const destroy = vi.spyOn(view!, 'destroy');
  closeDocument(opened);
  expect(opened.views.size).toBe(0);
  expect(destroy).toHaveBeenCalledOnce();
  await expect.poll(() => workerTraffic.live.size, SLOW_PDF_WORK).toBe(0);
  closeDocument(opened);
  screen.unmount();
});

test('a refresh into a password prompt comes back at the same page and zoom; the toolbar is labelled', async () => {
  const first = blobUrlOf(pdfBytes({ pages: numberedPages('Open') }));
  const screen = await render(sized(<PdfRenderer {...rendererProps(first, 1)} />));
  await expect.poll(pageIndicator, SLOW_PDF_WORK).toBe('Page 1 of 40');
  expect([
    part('pdf-toolbar')!.getAttribute('role'),
    part('pdf-toolbar')!.getAttribute('aria-label'),
  ]).toEqual(['toolbar', 'report.pdf controls']);
  await scrollToPage(14, 40);
  await userEvent.click(button('Zoom in'));
  await expect.poll(zoomLevel).toBe('125%');
  await expect.poll(pageIndicator).toBe('Page 15 of 40');

  const locked = blobUrlOf(pdfBytes({ pages: numberedPages('Locked'), password: 'open sesame' }));
  await screen.rerender(sized(<PdfRenderer {...rendererProps(locked, 2)} />));
  await expect.poll(() => part('pdf-password-input'), SLOW_PDF_WORK).not.toBeNull();
  await userEvent.type(part('pdf-password-input')!, 'open sesame');
  await userEvent.click(button('Submit'));
  await expect.poll(textLayerText, SLOW_PDF_WORK).toContain('Locked page 15');
  expect([pageIndicator(), zoomLevel()]).toEqual(['Page 15 of 40', '125%']);
  URL.revokeObjectURL(first);
  URL.revokeObjectURL(locked);
});
