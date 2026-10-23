import { afterEach, expect, test } from 'vitest';
import {
  closePresentation,
  hideSlide,
  openPresentation,
  showSlide,
  type OpenedPresentation,
} from '../src/slides';
import fontUrl from '../../pdf/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import {
  BAR_CHART,
  chartFrame,
  embeddedOpenType,
  pptxBytes,
  textShape,
  textSlides,
  type PptxFixture,
} from './fixtures/pptx';

const opened: OpenedPresentation[] = [];

afterEach(() => {
  for (const presentation of opened.splice(0)) closePresentation(presentation);
  document.body.replaceChildren();
});

async function open(fixture: PptxFixture, goToSlide: (index: number) => void = () => {}) {
  const bytes = pptxBytes(fixture);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const presentation = await openPresentation(data, new AbortController().signal, {
    externalMedia: 'block',
    goToSlide,
  });
  opened.push(presentation);
  return presentation;
}

function appAroundAHost(): { buttons: HTMLButtonElement[]; host: HTMLDivElement } {
  const place = (element: HTMLElement, css: string): void => {
    element.style.cssText = `position:absolute;${css}`;
    document.body.append(element);
  };
  const buttons = ['left:60px;top:0', 'left:370px;top:130px', 'left:60px;top:300px', 'left:0;top:130px'].map(
    (css, index) => {
      const button = document.createElement('button');
      button.textContent = `App ${index}`;
      place(button, `${css};width:50px;height:40px`);
      return button;
    },
  );
  const host = document.createElement('div');
  place(host, 'left:60px;top:80px;width:300px;height:200px');
  return { buttons, host };
}

const filledShape = (xfrm: string, extra = ''): string =>
  '<p:sp><p:nvSpPr><p:cNvPr id="40" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' +
  `${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>` +
  `${extra}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="4000"/><a:t>Big</a:t></a:r></a:p>` +
  '</p:txBody></p:sp>';

const CRAFTED_SHAPES: Record<string, string> = {
  'a box far larger than the slide': filledShape(
    '<a:xfrm><a:off x="-9000000000" y="-9000000000"/><a:ext cx="90000000000" cy="90000000000"/></a:xfrm>',
  ),
  'a rotated huge box': filledShape(
    '<a:xfrm rot="2700000"><a:off x="-90000000" y="-90000000"/><a:ext cx="900000000" cy="900000000"/></a:xfrm>',
  ),
  'a huge blurred shadow and glow': filledShape(
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="9000000" cy="9000000"/></a:xfrm>',
    '<a:effectLst><a:outerShdw blurRad="900000000" dist="900000000" dir="2700000" sx="1000000" sy="1000000">' +
      '<a:srgbClr val="000000"/></a:outerShdw><a:glow rad="90000000"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>',
  ),
  'a huge outline': filledShape(
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="9000000" cy="9000000"/></a:xfrm>',
    '<a:ln w="9000000000"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>',
  ),
  'huge text': textShape('HUGE').replace('<a:rPr lang="en-US"/>', '<a:rPr lang="en-US" sz="400000"/>'),
};

test.each(Object.entries(CRAFTED_SHAPES))(
  'nothing a slide draws covers the app (%s): a hit test over each app button finds the button',
  async (_name, shapes) => {
    const presentation = await open({ slides: [{ shapes }], widthPx: 300, heightPx: 200 });
    const { buttons, host } = appAroundAHost();
    const handle = showSlide(host, presentation, 0);
    await handle.ready;
    for (const button of buttons) {
      const box = button.getBoundingClientRect();
      expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(button);
    }
    expect(getComputedStyle(host).contain).toContain('paint');
    hideSlide(host, handle);
  },
);

const appTextWidth = (probe: HTMLElement): number => probe.getBoundingClientRect().width;
const embeddedFaces = (): FontFace[] =>
  [...document.fonts].filter((face) => face.family.includes('__pptx_embedded'));

test("an embedded font is scoped to the slide: the app's Arial is unchanged, and the face goes on hide", async () => {
  const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
  const presentation = await open({
    slides: [
      {
        shapes: textShape('Embedded').replace(
          '<a:rPr lang="en-US"/>',
          '<a:rPr lang="en-US"><a:latin typeface="Arial"/></a:rPr>',
        ),
      },
    ],
    presentationChildren:
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Arial"/><p:regular r:id="rIdFont"/></p:embeddedFont></p:embeddedFontLst>',
    presentationRelationships: [{ id: 'rIdFont', type: 'font', target: 'fonts/font1.fntdata' }],
    extraBinaryParts: { 'ppt/fonts/font1.fntdata': embeddedOpenType(font) },
  });
  const probe = document.createElement('span');
  probe.style.cssText = 'font: 40px Arial; white-space: nowrap';
  probe.textContent = 'iiiiiWWWWW';
  document.body.append(probe);
  const widthBefore = appTextWidth(probe);
  const { host } = appAroundAHost();

  const handle = showSlide(host, presentation, 0);
  await handle.ready;
  await expect.poll(() => embeddedFaces().some((face) => face.status === 'loaded')).toBe(true);
  expect(appTextWidth(probe)).toBe(widthBefore);

  hideSlide(host, handle);
  await expect.poll(() => embeddedFaces().length).toBe(0);
  expect(appTextWidth(probe)).toBe(widthBefore);
});

test('a jump to a slide out of range goes to the nearest slide, and a jump that is not an index goes nowhere', async () => {
  const jumps: number[] = [];
  const presentation = await open({ slides: textSlides(3) }, (index) => jumps.push(index));
  for (const slideIndex of [1e9, -5, 1, Number.NaN, 1.5]) presentation.rendering.onNavigate!({ slideIndex });
  expect(jumps).toEqual([2, 0, 1]);
});

test('nodes the renderer adds after drawing are checked too, until the slide is ready', async () => {
  const presentation = await open({ slides: textSlides(1) });
  const { host } = appAroundAHost();
  const handle = showSlide(host, presentation, 0);
  const late = document.createElement('div');
  late.innerHTML =
    '<iframe src="https://example.com/"></iframe><a href="javascript:alert(1)">late</a>' +
    '<div style="position: fixed; z-index: 99999"></div><style>:host { position: fixed }</style>';
  handle.element.append(late);
  await Promise.resolve();
  expect(late.querySelector('iframe')).toBeNull();
  expect(late.querySelector('style')).toBeNull();
  expect(late.querySelector('a')!.hasAttribute('href')).toBe(false);
  const fixed = late.querySelector<HTMLElement>('div')!;
  expect(fixed.style.position).toBe('');
  expect(fixed.style.zIndex).toBe('');
  hideSlide(host, handle);
});

test('no div in a slide is larger than the slide', async () => {
  const presentation = await open({
    slides: [{ shapes: CRAFTED_SHAPES['a box far larger than the slide']! }],
    widthPx: 300,
    heightPx: 200,
  });
  const { host } = appAroundAHost();
  const handle = showSlide(host, presentation, 0);
  for (const div of host.shadowRoot!.querySelectorAll('div')) {
    expect(div.getBoundingClientRect().width).toBeLessThanOrEqual(301);
  }
  hideSlide(host, handle);
});

const TOOLTIP_PROBE = `${location.origin}/__pptx-tooltip-probe__/`;
const probeUrl = (name: string): string => `${TOOLTIP_PROBE}${name}.png`;
const literal = (values: string[]): string =>
  `<c:ptCount val="${values.length}"/>` +
  values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('');
const legendWith = (runProperties: string): string =>
  '<c:legend><c:legendPos val="r"/><c:txPr><a:bodyPr/><a:p><a:pPr>' +
  `<a:defRPr sz="1000">${runProperties}</a:defRPr></a:pPr></a:p></c:txPr></c:legend>`;
const withLegend = (chart: string, runProperties: string): string =>
  chart.replace('</c:plotArea>', `</c:plotArea>${legendWith(runProperties)}`);
const bubbleChartNamed = (seriesName: string): string =>
  BAR_CHART.replace(
    /<c:barChart>[\s\S]*<\/c:barChart>/,
    '<c:bubbleChart><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/>' +
      `<c:tx><c:v>${seriesName}</c:v></c:tx><c:xVal><c:numLit>${literal(['1', '2', '3'])}</c:numLit></c:xVal>` +
      `<c:yVal><c:numLit>${literal(['1', '2', '3'])}</c:numLit></c:yVal>` +
      `<c:bubbleSize><c:numLit>${literal(['30', '30', '30'])}</c:numLit></c:bubbleSize></c:ser>` +
      '<c:axId val="1"/><c:axId val="2"/></c:bubbleChart>',
  );

async function showChart(chart: string) {
  const presentation = await open({
    slides: [
      {
        shapes: textShape('Chart') + chartFrame('rIdChart'),
        relationships: [{ id: 'rIdChart', type: 'chart', target: '../charts/chart1.xml' }],
      },
    ],
    extraParts: { 'ppt/charts/chart1.xml': chart },
  });
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px';
  document.body.append(host);
  const handle = showSlide(host, presentation, 0);
  await handle.ready;
  await expect.poll(() => host.shadowRoot!.querySelector('canvas')).toBeTruthy();
  return { presentation, host, handle };
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function hoverAcross(canvas: HTMLCanvasElement): Promise<void> {
  const box = canvas.getBoundingClientRect();
  for (let row = 0; row < 12; row++) {
    for (let column = 0; column < 30; column++) {
      const point = {
        clientX: box.left + box.width * (0.05 + column * 0.03),
        clientY: box.top + box.height * (0.05 + row * 0.075),
      };
      canvas.dispatchEvent(new MouseEvent('mousemove', { ...point, bubbles: true }));
    }
    await nextFrame();
  }
}

const tooltipElements = (root: ShadowRoot): Element[] =>
  [...root.querySelectorAll('div')].filter(
    (div) => div.children.length > 0 && div.style.boxShadow !== '' && div.style.display !== 'none',
  );

async function expectHoverMakesNoRequest(chart: string): Promise<void> {
  performance.clearResourceTimings();
  const { host, handle } = await showChart(chart);
  await hoverAcross(host.shadowRoot!.querySelector('canvas')!);
  expect(tooltipElements(host.shadowRoot!)).toEqual([]);
  expect(host.shadowRoot!.innerHTML).not.toMatch(/url\([^)]*__pptx-tooltip-probe__/);
  const control = probeUrl('control');
  await fetch(control);
  const requested = (): string[] =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(TOOLTIP_PROBE));
  await expect.poll(requested).toContain(control);
  expect(requested()).toEqual([control]);
  hideSlide(host, handle);
}

test('hovering a chart shows no tooltip and fetches nothing: a line break in a legend font', async () => {
  await expectHoverMakesNoRequest(
    withLegend(BAR_CHART, `<a:latin typeface="a&#10;;background-image:url(${probeUrl('font')});x:y&#10;z"/>`),
  );
});

test('hovering a chart shows no tooltip and fetches nothing: a CSS payload in legend and series colours', async () => {
  const seriesFill = `<c:spPr><a:solidFill><a:srgbClr val="FF0000;background-image:url(${probeUrl('series')})"/></a:solidFill></c:spPr>`;
  const legendFill = `<a:solidFill><a:srgbClr val="000000;background-image:url(${probeUrl('legend')})"/></a:solidFill>`;
  await expectHoverMakesNoRequest(
    withLegend(BAR_CHART.replace('<c:cat>', `${seriesFill}<c:cat>`), legendFill),
  );
});

test('hovering a chart shows no tooltip and fetches nothing: escaped markup in a bubble series name', async () => {
  const markup =
    `&lt;img src="${probeUrl('image')}"&gt;&lt;b style="display:block;background-image:url(${probeUrl('style')})"&gt;` +
    `bold&lt;/b&gt;&lt;link rel="stylesheet" href="${probeUrl('link')}"&gt;`;
  await expectHoverMakesNoRequest(bubbleChartNamed(markup));
});

test('hovering a chart shows no tooltip and fetches nothing: a namespaced x:typeface, cleaned at open', async () => {
  const payload = `a&#10;;background-image:url(${probeUrl('namespaced')});x:y&#10;z`;
  const chart = withLegend(BAR_CHART, `<a:latin xmlns:x="urn:x" x:typeface="${payload}"/>`);
  await expectHoverMakesNoRequest(chart);
  const presentation = await open({ slides: textSlides(1), extraParts: { 'ppt/charts/chart1.xml': chart } });
  const latin = presentation.presentation.charts
    .get('ppt/charts/chart1.xml')!
    .element!.querySelector('latin')!;
  expect(latin.getAttributeNS('urn:x', 'typeface')).not.toMatch(/[\n;()]/);
});

test('checking a late link costs a bounded number of observer records, and the check never feeds itself', async () => {
  const delivered = { records: 0 };
  const NativeObserver = window.MutationObserver;
  const mostRecords = 100;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        delivered.records += records.length;
        if (delivered.records > mostRecords) return observer.disconnect();
        callback(records, observer);
      });
    }
  };
  try {
    const presentation = await open({ slides: textSlides(1) });
    const { host } = appAroundAHost();
    const handle = showSlide(host, presentation, 0);
    await handle.ready;
    delivered.records = 0;
    const link = document.createElement('a');
    link.setAttribute('href', 'https://example.com/');
    link.textContent = 'late';
    handle.element.append(link);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(delivered.records).toBeLessThanOrEqual(3);
    hideSlide(host, handle);
  } finally {
    window.MutationObserver = NativeObserver;
  }
});
