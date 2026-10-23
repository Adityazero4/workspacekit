import {
  buildPresentation,
  parseZip,
  RECOMMENDED_ZIP_LIMITS,
  renderSlide,
  type PresentationData,
  type SlideHandle,
  type SlideRendererOptions,
  type ThemeData,
} from '@aiden0z/pptx-renderer';
import { safeUrlOrNull } from '@scope/react/renderer-kit';
import { assertArchiveWithinLimits, assertPartsWithinLimits, assertSlideSizeWithinLimits } from './limits';
import { isSlideWithinLimits, type SlideWorkCache } from './slideWork';

/**
 * How slides are drawn: whether media linked from outside the file is fetched, and where a link to another
 * slide goes (its 0-based index).
 *
 * @example
 * ```ts
 * const options: SlideOptions = { externalMedia: 'block', goToSlide: (index) => pages.scrollToPage(index) };
 * ```
 */
export interface SlideOptions {
  externalMedia: 'block' | 'allow';
  goToSlide: (index: number) => void;
}

/**
 * An opened presentation and what its slides share: the object URLs of its embedded media, its live charts
 * and the work counted for it. `closePresentation` releases them. `slideSources` keeps each slide's XML, so a
 * hidden slide can drop its parsed shapes and be parsed again when it is next drawn.
 *
 * @example
 * ```ts
 * const opened: OpenedPresentation = await openPresentation(buffer, signal, options);
 * ```
 */
export interface OpenedPresentation {
  presentation: PresentationData;
  rendering: SlideRendererOptions;
  hostCss: string;
  mediaUrls: Map<string, string>;
  charts: NonNullable<SlideRendererOptions['chartInstances']>;
  counted: SlideWorkCache;
  slideSources: ReadonlyArray<string | undefined>;
}

function goToSlideWithin(slideCount: number, index: number | undefined, options: SlideOptions): void {
  if (index === undefined || !Number.isInteger(index) || slideCount === 0) return;
  options.goToSlide(Math.min(Math.max(index, 0), slideCount - 1));
}

const UNSAFE_IN_FONT_NAME = /[\p{Cc};{}\\"'()<>]/gu;

const safeFontName = (name: string): string => name.replace(UNSAFE_IN_FONT_NAME, '');

function cleanTypefaces(root: Element | null): void {
  for (const element of root?.getElementsByTagName('*') ?? []) {
    for (const attribute of element.attributes) {
      if (attribute.localName !== 'typeface') continue;
      const safeName = safeFontName(attribute.value);
      if (safeName !== attribute.value) attribute.value = safeName;
    }
  }
}

type Chart = OpenedPresentation['charts'] extends Set<infer Instance> ? Instance : never;

class ChartsWithoutTooltips extends Set<Chart> {
  override add(chart: Chart): this {
    chart.setOption({ tooltip: { showContent: false } });
    return super.add(chart);
  }
}

function cleanThemeFonts(theme: ThemeData): void {
  for (const font of [theme.majorFont, theme.minorFont]) {
    font.latin = safeFontName(font.latin);
    font.ea = safeFontName(font.ea);
    font.cs = safeFontName(font.cs);
    for (const script of Object.keys(font.scripts ?? {})) {
      font.scripts![script] = safeFontName(font.scripts![script]!);
    }
  }
}

function cleanChartFonts(presentation: PresentationData): void {
  for (const part of [...presentation.charts.values(), ...(presentation.chartStyles?.values() ?? [])]) {
    cleanTypefaces(part.element);
  }
  for (const theme of [...presentation.themes.values(), ...(presentation.chartThemes?.values() ?? [])]) {
    cleanThemeFonts(theme);
  }
}

const hostCssFor = ({ width, height }: PresentationData): string =>
  ':host{all:initial;display:block;contain:paint;overflow:hidden;transform-origin:0 0}' +
  `div{max-width:${width}px!important;max-height:${height}px!important}`;

/**
 * Opens a `.pptx`: inflates it once within `PPTX_LIMITS`, unpacks it with the renderer's own zip limits,
 * checks its parts and slide size, and builds it with slides parsed only when first drawn. Each chart has its
 * tooltip content turned off as the renderer registers it, before it can be hovered: ECharts builds a
 * tooltip's CSS text and HTML from the deck's fonts, colours and series names, and the browser would fetch
 * what they smuggle in before any check could run. Font names in its charts and themes (a `typeface` in any
 * namespace) also lose control characters and `; { } \ " ' ( ) < >`. Checks `signal`
 * after every step that waits. Rejects with `DocumentLimitExceeded` for a presentation over the limits, the
 * signal's reason when aborted, or the renderer's error.
 *
 * @example
 * ```ts
 * const opened = await openPresentation(buffer, controller.signal, { externalMedia: 'block', goToSlide });
 * ```
 */
export async function openPresentation(
  data: ArrayBuffer,
  signal: AbortSignal,
  options: SlideOptions,
): Promise<OpenedPresentation> {
  await assertArchiveWithinLimits(new Uint8Array(data), signal);
  const files = await parseZip(data, RECOMMENDED_ZIP_LIMITS);
  signal.throwIfAborted();
  assertPartsWithinLimits(files);
  const presentation = buildPresentation(files, { lazySlides: true });
  assertSlideSizeWithinLimits(presentation);
  cleanChartFonts(presentation);
  const mediaUrls = new Map<string, string>();
  const charts: OpenedPresentation['charts'] = new ChartsWithoutTooltips();
  const rendering: SlideRendererOptions = {
    externalMedia: options.externalMedia,
    pdfjs: false,
    mediaUrlCache: mediaUrls,
    chartInstances: charts,
    onNavigate: ({ slideIndex }) => goToSlideWithin(presentation.slides.length, slideIndex, options),
  };
  return {
    presentation,
    rendering,
    hostCss: hostCssFor(presentation),
    mediaUrls,
    charts,
    counted: { parts: new Map(), referenced: new Map(), pixels: new Map() },
    slideSources: presentation.slides.map((slide) => slide.sourceXml),
  };
}

/**
 * Releases what an opened presentation's slides share once none is shown: disposes any chart still alive and
 * revokes the object URLs of its embedded media.
 *
 * @example
 * ```ts
 * closePresentation(opened);
 * ```
 */
export function closePresentation(opened: OpenedPresentation): void {
  for (const chart of opened.charts) if (!chart.isDisposed()) chart.dispose();
  opened.charts.clear();
  for (const url of opened.mediaUrls.values()) URL.revokeObjectURL(url);
  opened.mediaUrls.clear();
}

const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'src',
  'href',
  'poster',
  'background',
  'action',
  'formaction',
  'ping',
]);
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  'object',
  'embed',
  'iframe',
  'script',
  'foreignobject',
  'style',
  'link',
  'base',
  'meta',
  'form',
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
  'animatecolor',
  'mpath',
  'discard',
]);
const MEDIA_ELEMENTS: ReadonlySet<string> = new Set(['img', 'image', 'video', 'audio', 'source']);
const MEDIA_URL = /^[\t\n\f\r ]*(?:blob:|data:|#)/i;
const FRAGMENT_URL = /^[\t\n\f\r ]*#/;
const FILE_LOCAL_SCHEMES = ['blob:', 'data:', '#'];
const CONTAINED_POSITIONS: ReadonlySet<string> = new Set(['static', 'relative', 'absolute']);
const INTEGER = /^[+-]?\d+$/;
const HIGHEST_Z_INDEX = 1000;
const WEB_OR_MAIL_LINK = /^(?:https?:\/\/|mailto:)/i;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CSS_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\f']);
const URL_FUNCTION = 'url(';

function afterWhitespace(text: string, at: number): number {
  while (at < text.length && CSS_WHITESPACE.has(text[at]!)) at++;
  return at;
}

function hasExternalCssReference(value: string): boolean {
  const text = value.toLowerCase();
  if (text.includes('image-set(')) return true;
  for (let at = text.indexOf(URL_FUNCTION); at !== -1; at = text.indexOf(URL_FUNCTION, at)) {
    at = afterWhitespace(text, at + URL_FUNCTION.length);
    if (text[at] === '"' || text[at] === "'") at = afterWhitespace(text, at + 1);
    if (!FILE_LOCAL_SCHEMES.some((scheme) => text.startsWith(scheme, at))) return true;
  }
  return false;
}

function isAllowedDeclaration(property: string, value: string): boolean {
  if (hasExternalCssReference(value) || (property.startsWith('--') && value.includes('\\'))) return false;
  if (property === 'position') return CONTAINED_POSITIONS.has(value.trim().toLowerCase());
  return property !== 'z-index' || (INTEGER.test(value.trim()) && Number(value) <= HIGHEST_Z_INDEX);
}

function confineDeclarations(declarations: CSSStyleDeclaration): void {
  for (const property of [...declarations]) {
    if (!isAllowedDeclaration(property, declarations.getPropertyValue(property))) {
      declarations.removeProperty(property);
    }
  }
}

function webOrMailLinkOrNull(href: string): string | null {
  if (!WEB_OR_MAIL_LINK.test(href)) return null;
  if (/^mailto:/i.test(href)) return href;
  const allowed = safeUrlOrNull(href);
  if (!allowed) return null;
  const { username, password } = new URL(allowed);
  return username || password ? null : allowed;
}

function setAttributeIfDifferent(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function keepOnlyWebOrMailLink(link: Element, href: Attr): void {
  const allowed = webOrMailLinkOrNull(href.value.trim());
  const isPlainHref = href.namespaceURI === null;
  if (!allowed || !isPlainHref) link.removeAttributeNode(href);
  if (!allowed) return;
  setAttributeIfDifferent(link, 'href', allowed);
  setAttributeIfDifferent(link, 'target', '_blank');
  setAttributeIfDifferent(link, 'rel', 'noopener noreferrer');
}

function isFetchingAttribute(element: Element, attribute: Attr): boolean {
  if (attribute.localName === 'srcset') return true;
  if (URL_ATTRIBUTES.has(attribute.localName)) {
    return !(MEDIA_ELEMENTS.has(element.localName) ? MEDIA_URL : FRAGMENT_URL).test(attribute.value);
  }
  if (element.namespaceURI !== SVG_NAMESPACE) return false;
  return attribute.value.includes('\\') || hasExternalCssReference(attribute.value);
}

const isRenderersBackgroundFill = (element: Element): boolean =>
  element.children.length === 1 && element.firstElementChild!.matches('div[data-pptx-shape-background]');

const isForbiddenElement = (element: Element): boolean =>
  FORBIDDEN_ELEMENTS.has(element.localName.toLowerCase()) &&
  !(element.localName === 'foreignObject' && isRenderersBackgroundFill(element));

function confineAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name);
    else if (attribute.name === 'style') confineDeclarations((element as HTMLElement).style);
    else if (element.localName === 'a' && attribute.localName === 'href') {
      keepOnlyWebOrMailLink(element, attribute);
    } else if (isFetchingAttribute(element, attribute)) element.removeAttributeNode(attribute);
  }
}

/**
 * Checks a drawn slide, or nodes the renderer adds to it later, before they are shown, whatever the
 * renderer already filtered (it never creates any of what is removed here). It removes `object`, `embed`,
 * `iframe`, `script`, `style`, `link`, `base`, `meta`, `form` and `foreignObject` elements (except the
 * renderer's own shape-background `foreignObject`, whose one child is its background `div`), SVG animation
 * elements (`animate`, `set`, `animateTransform`, `animateMotion`, `animateColor`, `mpath`, `discard`, which
 * could change an attribute after it was checked), and `on*` attributes. Links keep only absolute
 * `http(s):` URLs without a user name or password and `mailto:`, opened in a new tab with `noopener
 * noreferrer`, written as a plain `href` (an `xlink:href` on an SVG link goes). `src`, `href` and
 * `xlink:href`, `poster`, `ping` and the like keep `blob:` and `data:` URLs only on media (`img`, SVG
 * `image`, `video`, `audio`, `source`), and only `#fragments` elsewhere (an SVG `use` may point inside the
 * slide, not at a `data:` document); `srcset` always goes. An SVG attribute holding a CSS escape is removed
 * (`u\72l(` is `url(` to the CSS parser), as is one that would fetch.
 * Inline-style declarations go when they would fetch (`url()` other than `blob:`, `data:` or `#`,
 * `image-set()`), set any `position` other than exactly `static`, `relative` or `absolute`, or set a
 * `z-index` that is not an integer up to 1000, so nothing is drawn outside the slide's box. Scanning a value
 * for `url(` is linear in its length, and skips only CSS whitespace (space, tab, line feed, carriage return,
 * form feed): a no-break space before `data:` makes a relative URL, which would fetch from the app's origin.
 * This checks what will be shown; it cannot cancel a request the renderer itself starts while drawing (it
 * draws with the slide briefly attached to the page, and an image starts loading once its `src` is set),
 * which is why external media is blocked in the renderer by default.
 *
 * @example
 * ```ts
 * confineSlide(handle.element);
 * ```
 */
export function confineSlide(root: Element): void {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (isForbiddenElement(element)) element.remove();
    else confineAttributes(element);
  }
}

function confineWhileShown(root: HTMLElement): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) confineSlide(node);
      if (record.type === 'attributes' && record.target instanceof Element) confineAttributes(record.target);
    }
    observer.takeRecords();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true });
  return () => observer.disconnect();
}

/**
 * Whether slide `index` costs no more work to draw than `PPTX_LIMITS` allows (see `isSlideWithinLimits`).
 * Ask before `showSlide`; the answer is kept, so asking on every render is cheap.
 *
 * @example
 * ```ts
 * if (!canShowSlide(opened, index)) return 'too large';
 * ```
 */
export function canShowSlide(opened: OpenedPresentation, index: number): boolean {
  return isSlideWithinLimits(opened.presentation, opened.presentation.slides[index]!, opened.counted);
}

const releaseWhenHidden = new WeakMap<SlideHandle, () => void>();

function dropParsedShapes(opened: OpenedPresentation, index: number): void {
  const sourceXml = opened.slideSources[index];
  if (sourceXml === undefined) return;
  Object.assign(opened.presentation.slides[index]!, {
    nodes: [],
    background: undefined,
    sourceXml,
    nodesMaterialized: false,
    placeholderInheritanceResolved: false,
  });
}

/**
 * Draws slide `index`, which `canShowSlide` allowed, into the shadow root of `host`, checked with
 * `confineSlide`, and checks what the renderer and its charts add or change later (charts, their tooltips,
 * text it lays out again, images it filters) the same way until `hideSlide`. Each check sets an attribute
 * only when its value changes and drops the records its own changes make, so it never feeds itself. The
 * shadow root keeps the app's styles off the
 * slide and the slide's ids to itself; its host contains the slide's paint, and no `div` in it is larger than
 * the slide, so a chart's canvas never is. Returns the renderer's handle, for `hideSlide`.
 *
 * @example
 * ```ts
 * const handle = showSlide(element, opened, 0);
 * ```
 */
export function showSlide(host: HTMLElement, opened: OpenedPresentation, index: number): SlideHandle {
  const handle = renderSlide(opened.presentation, opened.presentation.slides[index]!, opened.rendering);
  confineSlide(handle.element);
  const stopConfining = confineWhileShown(handle.element);
  releaseWhenHidden.set(handle, () => {
    stopConfining();
    dropParsedShapes(opened, index);
  });
  const style = document.createElement('style');
  style.textContent = opened.hostCss;
  (host.shadowRoot ?? host.attachShadow({ mode: 'open' })).replaceChildren(style, handle.element);
  return handle;
}

/**
 * Disposes a drawn slide (its charts and fonts), empties its host's shadow root and drops the slide's parsed
 * shapes, which are parsed again from its XML when it is next drawn: however far a long deck is scrolled,
 * only the slides on screen hold parsed shapes.
 *
 * @example
 * ```ts
 * hideSlide(element, handle);
 * ```
 */
export function hideSlide(host: HTMLElement, handle: SlideHandle): void {
  releaseWhenHidden.get(handle)?.();
  handle.dispose();
  host.shadowRoot?.replaceChildren();
}
