import { createRef, type ReactNode } from 'react';
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { VirtualPages, type VirtualPagesHandle, type VirtualPagesProps } from '../src/renderers';

const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 500;
const GAP = 16;
const VIEWPORT_WIDTH = 600;
const VIEWPORT_HEIGHT = 600;
const PAGES_ON_SCREEN_AT_MOST = Math.ceil(VIEWPORT_HEIGHT / (PAGE_HEIGHT + GAP)) + 1;

const pageTop = (index: number, zoom = 1): number => GAP + index * (PAGE_HEIGHT * zoom + GAP);

const viewport = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=pages-viewport]')!;
const mountedPages = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-fs-part=pages-page]'),
];
const pageElement = (index: number): HTMLElement | undefined =>
  mountedPages().find((page) => page.textContent === `page ${index}`);

const midpointFractionOf = (index: number): number | undefined => {
  const page = pageElement(index);
  if (!page) return undefined;
  const surface = viewport().getBoundingClientRect();
  const rect = page.getBoundingClientRect();
  return (surface.top + surface.height / 2 - rect.top) / rect.height;
};

function renderPages(props: Partial<VirtualPagesProps> = {}): ReturnType<typeof render> {
  return render(<Pages {...props} />);
}

function Pages(props: Partial<VirtualPagesProps> & { viewportHeight?: number }): ReactNode {
  const { viewportHeight = VIEWPORT_HEIGHT, ...pagesProps } = props;
  return (
    <div style={{ width: VIEWPORT_WIDTH, height: viewportHeight, display: 'flex' }}>
      <VirtualPages
        pageCount={500}
        estimatePageSize={() => ({ width: PAGE_WIDTH, height: PAGE_HEIGHT })}
        renderPage={(page) => `page ${page.index}`}
        aria-label="Document pages"
        {...pagesProps}
      />
    </div>
  );
}

test('500 pages mount only the visible ones plus overscan', async () => {
  const geometries: number[] = [];
  await renderPages({
    renderPage: (page) => {
      geometries.push(page.zoom);
      return `page ${page.index}`;
    },
  });
  await expect.poll(() => mountedPages().length).toBeGreaterThan(1);
  expect(mountedPages().length).toBeLessThanOrEqual(PAGES_ON_SCREEN_AT_MOST + 1);
  expect(viewport().scrollHeight).toBe(GAP + 500 * (PAGE_HEIGHT + GAP));
  const firstPage = pageElement(0)!.getBoundingClientRect();
  const surface = viewport().getBoundingClientRect();
  expect(firstPage.height).toBe(PAGE_HEIGHT);
  expect(Math.abs(firstPage.left - surface.left - (viewport().clientWidth - PAGE_WIDTH) / 2)).toBeLessThan(1);
  expect(viewport().scrollWidth).toBe(viewport().clientWidth);

  viewport().scrollTop = pageTop(250);
  await expect.poll(() => pageElement(250)).toBeDefined();
  expect(mountedPages().length).toBeLessThanOrEqual(PAGES_ON_SCREEN_AT_MOST + 2);
  expect(pageElement(0)).toBeUndefined();
  expect(new Set(geometries)).toEqual(new Set([1]));
});

test('a page whose gap is the only part on screen counts as off screen for the overscan', async () => {
  await renderPages({ overscan: 1 });
  await expect.poll(() => pageElement(0)).toBeDefined();
  viewport().scrollTop = pageTop(11) - GAP / 2;
  await expect.poll(() => pageElement(11)).toBeDefined();
  expect(pageElement(10), 'the page above the visible ones, as overscan').toBeDefined();
  expect(pageElement(9), 'only the gap below it is on screen').toBeUndefined();
});

test('mount/unmount callbacks fire once per page lifetime', async () => {
  const events: string[] = [];
  const callbacks = (): Partial<VirtualPagesProps> => ({
    initialPage: 20,
    onPageMount: (index) => events.push(`mount ${index}`),
    onPageUnmount: (index) => events.push(`unmount ${index}`),
  });
  const screen = await renderPages(callbacks());
  await expect.poll(() => pageElement(20)).toBeDefined();
  expect(events).toContain('mount 20');
  expect(events).not.toContain('mount 0');

  for (const index of [21, 22, 23, 30, 31]) {
    viewport().scrollTop = pageTop(index);
    await expect.poll(() => mountedPages()[0]?.textContent).toBe(`page ${index - 1}`);
  }
  const eventsBeforeRerender = events.length;
  await screen.rerender(<Pages {...callbacks()} />);
  expect(events).toHaveLength(eventsBeforeRerender);

  await screen.unmount();
  const lifetimes = new Map<string, string[]>();
  for (const event of events) {
    const [kind, index] = event.split(' ') as [string, string];
    lifetimes.set(index, [...(lifetimes.get(index) ?? []), kind]);
  }
  for (const [index, kinds] of lifetimes) {
    expect(kinds, `page ${index}`).toEqual(kinds.map((_, at) => (at % 2 === 0 ? 'mount' : 'unmount')));
    expect(kinds.length % 2, `page ${index} is unmounted at the end`).toBe(0);
  }
});

test('currentPage follows the viewport midpoint', async () => {
  const changes: number[] = [];
  await renderPages({ onCurrentPageChange: (index) => changes.push(index) });
  await expect.poll(() => pageElement(0)).toBeDefined();

  viewport().scrollTop = pageTop(10);
  await expect.poll(() => changes.at(-1)).toBe(10);
  viewport().scrollTop = pageTop(10) + PAGE_HEIGHT - VIEWPORT_HEIGHT / 2 + GAP + 1;
  await expect.poll(() => changes.at(-1)).toBe(11);
  viewport().scrollTop = 0;
  await expect.poll(() => changes.at(-1)).toBe(0);

  expect(changes).toEqual([10, 11, 0]);
});

test('zooming keeps the current page anchored', async () => {
  const changes: number[] = [];
  const mountsAfterZoom: number[] = [];
  let zooming = false;
  const props = (zoom: number): Partial<VirtualPagesProps> => ({
    zoom,
    onCurrentPageChange: (index) => changes.push(index),
    onPageMount: (index) => void (zooming && mountsAfterZoom.push(index)),
  });
  const screen = await renderPages(props(1));
  viewport().scrollTop = pageTop(10) + 0.4 * PAGE_HEIGHT - VIEWPORT_HEIGHT / 2;
  await expect.poll(() => changes.at(-1)).toBe(10);
  await expect.poll(() => midpointFractionOf(10)).toBeCloseTo(0.4, 2);

  zooming = true;
  await screen.rerender(<Pages {...props(2)} />);
  await expect.poll(() => pageElement(10)?.getBoundingClientRect().height).toBe(PAGE_HEIGHT * 2);
  await expect.poll(() => midpointFractionOf(10)).toBeCloseTo(0.4, 2);
  expect(changes.at(-1)).toBe(10);
  expect(mountsAfterZoom.filter((index) => index < 9 || index > 11)).toEqual([]);
  expect(viewport().scrollWidth).toBeGreaterThan(viewport().clientWidth);
  expect(viewport().getAttribute('data-zoomed')).toBe('');

  await screen.rerender(<Pages {...props(0.5)} />);
  await expect.poll(() => pageElement(10)?.getBoundingClientRect().height).toBe(PAGE_HEIGHT / 2);
  await expect.poll(() => midpointFractionOf(10)).toBeCloseTo(0.4, 2);
  expect(changes.at(-1)).toBe(10);
  expect(viewport().hasAttribute('data-zoomed')).toBe(false);
});

test('scrollToPage and the page keys', async () => {
  const changes: number[] = [];
  const handle = createRef<VirtualPagesHandle>();
  await renderPages({ ref: handle, onCurrentPageChange: (index) => changes.push(index) });
  const surface = viewport();
  expect(surface.getAttribute('role')).toBe('region');
  expect(surface.getAttribute('aria-label')).toBe('Document pages');
  expect(surface.tabIndex).toBe(0);

  handle.current!.scrollToPage(42);
  await expect.poll(() => changes.at(-1)).toBe(42);
  await expect.poll(() => surface.scrollTop).toBe(pageTop(42) - GAP);

  surface.focus();
  await userEvent.keyboard('{PageDown}');
  await expect.poll(() => surface.scrollTop).toBe(pageTop(43) - GAP);
  await userEvent.keyboard('{PageUp}');
  await expect.poll(() => surface.scrollTop).toBe(pageTop(42) - GAP);
  await userEvent.keyboard('{End}');
  await expect.poll(() => changes.at(-1)).toBe(499);
  expect(surface.scrollTop).toBe(surface.scrollHeight - surface.clientHeight);
  await userEvent.keyboard('{Home}');
  await expect.poll(() => changes.at(-1)).toBe(0);
  expect(surface.scrollTop).toBe(0);

  const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  expect(surface.dispatchEvent(arrowDown)).toBe(true);
});

test('a new estimatePageSize with the same sizes keeps the layout; a real size change re-anchors', async () => {
  let renderedPages = 0;
  const props = (pageHeight: number): Partial<VirtualPagesProps> => ({
    estimatePageSize: () => ({ width: PAGE_WIDTH, height: pageHeight }),
    renderPage: (page) => {
      renderedPages++;
      return `page ${page.index}`;
    },
  });
  const screen = await renderPages(props(PAGE_HEIGHT));
  viewport().scrollTop = pageTop(10) + 0.4 * PAGE_HEIGHT - VIEWPORT_HEIGHT / 2 + 0.5;
  await expect.poll(() => mountedPages()[0]?.textContent).toBe('page 8');
  const scrollTopBefore = viewport().scrollTop;

  renderedPages = 0;
  await screen.rerender(<Pages {...props(PAGE_HEIGHT)} />);
  expect(renderedPages).toBe(mountedPages().length);
  expect(viewport().scrollTop).toBe(scrollTopBefore);

  await screen.rerender(<Pages {...props(PAGE_HEIGHT * 2)} />);
  await expect.poll(() => pageElement(10)?.getBoundingClientRect().height).toBe(PAGE_HEIGHT * 2);
  await expect.poll(() => midpointFractionOf(10)).toBeCloseTo(0.4, 2);
});

test('currentPage is reported on mount and when the viewport is resized', async () => {
  const changes: number[] = [];
  const props = { onCurrentPageChange: (index: number) => void changes.push(index) };
  const screen = await render(<Pages {...props} viewportHeight={VIEWPORT_HEIGHT * 2} />);
  await expect.poll(() => changes).toEqual([1]);

  await screen.rerender(<Pages {...props} viewportHeight={VIEWPORT_HEIGHT} />);
  await expect.poll(() => changes).toEqual([1, 0]);
});
