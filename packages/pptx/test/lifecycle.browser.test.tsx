import type * as PptxRenderer from '@aiden0z/pptx-renderer';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { PptxViewer, type PptxViewerProps } from '../src';
import { closePresentation, hideSlide, openPresentation, showSlide } from '../src/slides';
import {
  BAR_CHART,
  chartFrame,
  chartFrameSized,
  inflationBomb,
  pngOfSize,
  picture,
  pptxBytes,
  textShape,
  textSlides,
  withDeclaredSize,
} from './fixtures/pptx';

const engine = vi.hoisted(() => ({
  parsed: 0,
  built: 0,
  rendered: 0,
  disposed: 0,
  parseGate: Promise.resolve(),
  parses: [] as Promise<unknown>[],
}));

vi.mock('@aiden0z/pptx-renderer', async (importOriginal) => {
  const original = await importOriginal<typeof PptxRenderer>();
  return {
    ...original,
    parseZip: (...args: Parameters<typeof original.parseZip>) => {
      engine.parsed++;
      const parse = engine.parseGate.then(() => original.parseZip(...args));
      engine.parses.push(parse.catch(() => undefined));
      return parse;
    },
    buildPresentation: (...args: Parameters<typeof original.buildPresentation>) => {
      engine.built++;
      return original.buildPresentation(...args);
    },
    renderSlide: (...args: Parameters<typeof original.renderSlide>) => {
      engine.rendered++;
      const handle = original.renderSlide(...args);
      return {
        element: handle.element,
        ready: handle.ready,
        dispose: () => {
          engine.disposed++;
          handle.dispose();
        },
        [Symbol.dispose]: () => handle.dispose(),
      };
    },
  };
});

const TOO_LARGE_COPY = 'This file is too large to preview. Download it instead.';
const MEBIBYTE = 1024 * 1024;
const FIRST_DRAW_TIMEOUT_MS = 5000;

beforeEach(() => {
  Object.assign(engine, {
    parsed: 0,
    built: 0,
    rendered: 0,
    disposed: 0,
    parseGate: Promise.resolve(),
    parses: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

const sized = (node: ReactNode): ReactNode => (
  <div style={{ height: 480, width: 1100, display: 'flex', flexDirection: 'column' }}>{node}</div>
);

const slideHosts = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-fs-part=pptx-slide]'),
];
const shownSlideTexts = (): string[] => slideHosts().map((host) => host.shadowRoot?.textContent ?? '');
const viewport = (): HTMLElement => document.querySelector<HTMLElement>('[data-fs-part=pages-viewport]')!;
const live = (): number => engine.rendered - engine.disposed;

async function showDeck(
  bytes: Uint8Array,
  props: Partial<PptxViewerProps> = {},
): Promise<{ unmount: () => Promise<void> }> {
  const screen = await render(sized(<PptxViewer src={bytes} fileName="deck.pptx" {...props} />));
  return { unmount: () => screen.unmount() };
}

test('only visible slides render; unmounted slides are disposed; all disposed on unmount', async () => {
  const { unmount } = await showDeck(pptxBytes({ slides: textSlides(200) }));
  await expect.poll(() => shownSlideTexts()[0], { timeout: FIRST_DRAW_TIMEOUT_MS }).toContain('Slide text 1');
  expect(engine.rendered).toBeGreaterThan(0);
  expect(engine.rendered).toBeLessThanOrEqual(5);
  expect(slideHosts().map((host) => host.getAttribute('aria-label'))[0]).toBe('Slide 1 of 200');

  viewport().scrollTop = viewport().scrollHeight / 2;
  await expect.poll(() => shownSlideTexts().some((text) => /Slide text 10\d/.test(text))).toBe(true);
  expect(shownSlideTexts().join()).not.toContain('Slide text 1,');
  expect(engine.disposed).toBeGreaterThan(0);
  expect(live()).toBe(slideHosts().length);
  expect(engine.rendered).toBeLessThan(20);

  await unmount();
  expect(engine.disposed).toBe(engine.rendered);
});

test('embedded media URLs are revoked when the presentation is closed', async () => {
  const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
  const bytes = pptxBytes({
    slides: [
      {
        shapes: picture('<a:blip r:embed="rIdImage"/>'),
        relationships: [{ id: 'rIdImage', type: 'image', target: '../media/photo.png' }],
      },
    ],
    media: { 'photo.png': new Uint8Array(64) },
  });
  const { unmount } = await showDeck(bytes);
  await expect.poll(() => slideHosts()[0]?.shadowRoot?.querySelector('img[src^="blob:"]')).toBeTruthy();
  const shownUrl = slideHosts()[0]!.shadowRoot!.querySelector('img')!.getAttribute('src');
  expect(createObjectUrl.mock.results.map((result) => result.value)).toContain(shownUrl);
  expect(revokeObjectUrl).not.toHaveBeenCalledWith(shownUrl);

  await unmount();
  expect(revokeObjectUrl).toHaveBeenCalledWith(shownUrl);
  expect(engine.disposed).toBe(engine.rendered);
});

test('a chart is disposed when its slide scrolls away, and every chart on unmount', async () => {
  const chartSlide = {
    shapes: textShape('Chart slide') + chartFrame('rIdChart'),
    relationships: [{ id: 'rIdChart', type: 'chart' as const, target: '../charts/chart1.xml' }],
  };
  const { unmount } = await showDeck(
    pptxBytes({
      slides: [chartSlide, ...textSlides(30), chartSlide],
      extraParts: { 'ppt/charts/chart1.xml': BAR_CHART },
    }),
  );
  const chartOf = (host: HTMLElement | undefined) => host?.shadowRoot?.querySelector('[_echarts_instance_]');
  await expect.poll(() => chartOf(slideHosts()[0])?.querySelector('canvas')).toBeTruthy();
  const firstChart = chartOf(slideHosts()[0])!;

  viewport().scrollTop = viewport().scrollHeight;
  await expect.poll(() => chartOf(slideHosts().at(-1))?.querySelector('canvas')).toBeTruthy();
  expect(firstChart.getAttribute('_echarts_instance_')).toBe('');
  expect(firstChart.childElementCount).toBe(0);
  const lastChart = chartOf(slideHosts().at(-1))!;

  await unmount();
  expect(lastChart.getAttribute('_echarts_instance_')).toBe('');
  expect(lastChart.childElementCount).toBe(0);
  expect(engine.disposed).toBe(engine.rendered);
});

test('the unmount-after-open race disposes everything: a parse that finishes after unmount builds nothing', async () => {
  let release = (): void => {};
  engine.parseGate = new Promise((resolve) => (release = resolve));
  const { unmount } = await showDeck(pptxBytes({ slides: textSlides(3) }));
  await expect.poll(() => engine.parsed).toBe(1);

  await unmount();
  release();
  await Promise.all(engine.parses);
  await Promise.resolve();

  expect(engine.built).toBe(0);
  expect(engine.rendered).toBe(0);
  expect(slideHosts()).toEqual([]);
});

test('zoom scales the drawn slides at once and re-renders them sharp once it settles', async () => {
  await showDeck(pptxBytes({ slides: textSlides(3) }));
  await expect.poll(() => shownSlideTexts()[0]).toContain('Slide text 1');
  const renderedBeforeZoom = engine.rendered;
  const mounted = slideHosts().length;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!);
  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!);
  expect(slideHosts()[0]!.style.transform).toBe('scale(1.5)');
  expect(engine.rendered).toBe(renderedBeforeZoom);

  vi.advanceTimersByTime(300);
  vi.useRealTimers();
  await expect.poll(() => engine.rendered).toBeGreaterThanOrEqual(renderedBeforeZoom + 1);
  await expect.poll(() => live()).toBe(slideHosts().length);
  expect(engine.rendered - renderedBeforeZoom).toBeLessThanOrEqual(mounted + 2);
  expect(slideHosts()[0]!.style.transform).toBe('scale(1.5)');
  expect(shownSlideTexts()[0]).toContain('Slide text 1');
});

test('zip limits reject a crafted inflation bomb before the renderer reads it', async () => {
  const onError = vi.fn();
  await showDeck(withDeclaredSize(inflationBomb(64), 'ppt/media/bomb.bin', 1000), { onError });
  await expect.poll(() => document.body.textContent).toContain(TOO_LARGE_COPY);
  expect(onError.mock.calls[0]![0].kind).toBe('too_large');
  expect(engine.parsed).toBe(0);
});

const EMU_PER_PX = 9525;
const errorTexts = (): (string | null)[] =>
  [...document.querySelectorAll('[data-fs-part=pptx-slide-error]')].map((error) => error.textContent);

function masterTextShape(id: number): string {
  const offset = `<a:off x="${(id % 90) * 10 * EMU_PER_PX}" y="${(id % 50) * 10 * EMU_PER_PX}"/>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>${offset}` +
    `<a:ext cx="${95 * EMU_PER_PX}" cy="${32 * EMU_PER_PX}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>` +
    '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/>' +
    '<a:t>word word word word word word word word word</a:t></a:r></a:p></p:txBody></p:sp>'
  );
}

const masterOf = (textShapes: number): string =>
  Array.from({ length: textShapes }, (_, index) => masterTextShape(index + 10)).join('');

test('a master with 2,200 text shapes is never drawn; each slide says it is too large', async () => {
  await showDeck(pptxBytes({ slides: textSlides(2), master: { shapes: masterOf(2200) } }));
  await expect
    .poll(errorTexts)
    .toEqual(['Slide 1 of 2 is too large to show.', 'Slide 2 of 2 is too large to show.']);
  expect(engine.rendered).toBe(0);
});

test('a master with 300 text shapes is drawn', async () => {
  await showDeck(pptxBytes({ slides: textSlides(1), master: { shapes: masterOf(300) } }));
  await expect.poll(() => shownSlideTexts()[0], { timeout: FIRST_DRAW_TIMEOUT_MS }).toContain('Slide text 1');
  expect(errorTexts()).toEqual([]);
});

const tabbedText = (tabs: number): string => textShape(`Tabs ${tabs} ${'a\tb'.repeat(tabs)}`);

test('a slide with more than 500 tabs is never drawn; the rest of the deck is', async () => {
  await showDeck(pptxBytes({ slides: [{ shapes: tabbedText(501) }, { shapes: tabbedText(100) }] }));
  await expect.poll(() => shownSlideTexts().join()).toContain('Tabs 100');
  expect(errorTexts()).toEqual(['Slide 1 of 2 is too large to show.']);
  expect(engine.rendered).toBe(1);
});

const DUOTONE = '<a:duotone><a:srgbClr val="000000"/><a:srgbClr val="FFFFFF"/></a:duotone>';

const slideWithEffectImages = (count: number, image: string, label: string) => ({
  shapes: textShape(label) + picture(`<a:blip r:embed="rIdImage">${DUOTONE}</a:blip>`).repeat(count),
  relationships: [{ id: 'rIdImage', type: 'image' as const, target: `../media/${image}` }],
});

test('images with canvas effects are refused over 25 MP a slide, counted from their headers', async () => {
  const media = { 'large.png': pngOfSize(4000, 4000), 'small.png': pngOfSize(1000, 1000) };
  const slides = [
    slideWithEffectImages(2, 'large.png', 'Two large'),
    slideWithEffectImages(3, 'small.png', 'Three small'),
  ];
  await showDeck(pptxBytes({ slides, media }));
  await expect.poll(() => shownSlideTexts().join()).toContain('Three small');
  expect(errorTexts()).toEqual(['Slide 1 of 2 is too large to show.']);
  expect(engine.rendered).toBe(1);
});

const slideWithCharts = (sizes: [number, number][], label: string) => ({
  shapes:
    textShape(label) + sizes.map(([width, height]) => chartFrameSized('rIdChart', width, height)).join(''),
  relationships: [{ id: 'rIdChart', type: 'chart' as const, target: '../charts/chart1.xml' }],
});

test('charts are refused over 4 slide areas a slide, and a frame larger than the slide is drawn no larger', async () => {
  const forty = Array.from({ length: 40 }, (): [number, number] => [800, 600]);
  await showDeck(
    pptxBytes({
      slides: [slideWithCharts(forty, 'Forty charts'), slideWithCharts([[30_000, 30_000]], 'Huge frame')],
      extraParts: { 'ppt/charts/chart1.xml': BAR_CHART },
    }),
  );
  await expect.poll(() => slideHosts()[0]?.shadowRoot?.querySelector('canvas')).toBeTruthy();
  expect(errorTexts()).toEqual(['Slide 1 of 2 is too large to show.']);
  const canvas = slideHosts()[0]!.shadowRoot!.querySelector('canvas')!;
  expect(canvas.width).toBeLessThanOrEqual(Math.ceil(960 * devicePixelRatio));
  expect(canvas.height).toBeLessThanOrEqual(Math.ceil(540 * devicePixelRatio));
});

test('under StrictMode, unmount disposes every slide, revokes every media URL and leaves no chart alive', async () => {
  const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
  const slide = {
    shapes: textShape('Strict') + picture('<a:blip r:embed="rIdImage"/>') + chartFrame('rIdChart'),
    relationships: [
      { id: 'rIdImage', type: 'image' as const, target: '../media/photo.png' },
      { id: 'rIdChart', type: 'chart' as const, target: '../charts/chart1.xml' },
    ],
  };
  const bytes = pptxBytes({
    slides: [slide, slide, slide],
    media: { 'photo.png': pngOfSize(8, 8) },
    extraParts: { 'ppt/charts/chart1.xml': BAR_CHART },
  });
  const screen = await render(
    <StrictMode>{sized(<PptxViewer src={bytes} fileName="deck.pptx" />)}</StrictMode>,
  );
  const chartOf = (host: HTMLElement): Element | null =>
    host.shadowRoot!.querySelector('[_echarts_instance_]');
  const isEveryChartDrawn = (): boolean =>
    slideHosts().length > 0 && slideHosts().every((host) => chartOf(host)?.querySelector('canvas'));
  await expect.poll(isEveryChartDrawn, { timeout: FIRST_DRAW_TIMEOUT_MS }).toBe(true);
  const charts = slideHosts().map((host) => chartOf(host)!);
  const blobUrls = createObjectUrl.mock.results.map((result) => result.value as string);
  expect(blobUrls.length).toBeGreaterThan(0);

  await screen.unmount();
  expect(engine.disposed).toBe(engine.rendered);
  for (const url of blobUrls) expect(revokeObjectUrl).toHaveBeenCalledWith(url);
  for (const chart of charts) {
    expect(chart.getAttribute('_echarts_instance_')).toBe('');
    expect(chart.childElementCount).toBe(0);
  }
});

test('a slide that shows one large image many times is never drawn; fewer uses are', async () => {
  const image = new Uint8Array(MEBIBYTE);
  const slideShowing = (times: number) => ({
    shapes: textShape(`Shown ${times} times`) + picture('<a:blip r:embed="rIdImage"/>').repeat(times),
    relationships: [{ id: 'rIdImage', type: 'image' as const, target: '../media/large.png' }],
  });
  await showDeck(pptxBytes({ slides: [slideShowing(10), slideShowing(200)], media: { 'large.png': image } }));
  await expect.poll(() => shownSlideTexts()[0]).toContain('Shown 10 times');
  await expect
    .poll(() => document.querySelector('[data-fs-part=pptx-slide-error]')?.textContent)
    .toBe('Slide 2 of 2 is too large to show.');
  expect(engine.rendered).toBe(1);
});

const slideWithAPictureAndAChart = {
  shapes: textShape('Mixed') + picture('<a:blip r:embed="rIdImage"/>') + chartFrame('rIdChart'),
  relationships: [
    { id: 'rIdImage', type: 'image' as const, target: '../media/photo.png' },
    { id: 'rIdChart', type: 'chart' as const, target: '../charts/chart1.xml' },
  ],
};

async function drawnMarkup(host: HTMLElement, handle: PptxRenderer.SlideHandle): Promise<string> {
  await handle.ready;
  await new Promise(requestAnimationFrame);
  return host.shadowRoot!.innerHTML.replace(/_echarts_instance_="[^"]*"/g, '');
}

test.each([
  ['text', pptxBytes({ slides: textSlides(2) }), []],
  [
    'a picture and a chart',
    pptxBytes({
      slides: [slideWithAPictureAndAChart, ...textSlides(1)],
      media: { 'photo.png': pngOfSize(8, 8) },
      extraParts: { 'ppt/charts/chart1.xml': BAR_CHART },
    }),
    ['img[src^="blob:"]', '[_echarts_instance_] canvas'],
  ],
])(
  'a hidden slide with %s drops its parsed shapes, and is parsed and drawn the same when shown again',
  async (_, bytes, drawnElements) => {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const opened = await openPresentation(data, new AbortController().signal, {
      externalMedia: 'block',
      goToSlide: () => {},
    });
    const host = document.createElement('div');
    document.body.append(host);
    const slide = opened.presentation.slides[0]!;
    try {
      const first = showSlide(host, opened, 0);
      expect(slide.nodes.length).toBeGreaterThan(0);
      const drawn = await drawnMarkup(host, first);
      for (const selector of drawnElements) expect(host.shadowRoot!.querySelector(selector)).not.toBeNull();
      hideSlide(host, first);
      expect(slide.nodes).toEqual([]);
      expect(slide.nodesMaterialized).toBe(false);

      const second = showSlide(host, opened, 0);
      expect(await drawnMarkup(host, second)).toBe(drawn);
      for (const selector of drawnElements) expect(host.shadowRoot!.querySelector(selector)).not.toBeNull();
      hideSlide(host, second);
    } finally {
      closePresentation(opened);
      host.remove();
    }
  },
);
