import type { PresentationData, SlideData } from '@aiden0z/pptx-renderer';
import { imagePixelsOf } from './imageSize';
import { PPTX_LIMITS } from './limits';

type Relationships = SlideData['rels'];

interface Reference {
  path: string;
  hasImageEffect: boolean;
  chartSlideAreas: number;
}

interface PartWork {
  weight: number;
  tabs: number;
  references: Reference[];
}

/**
 * What has been counted for one presentation, so each part is counted once however many slides show it:
 * `parts` by the path of a slide, layout or master, `referenced` by the path of a part a slide shows by
 * reference (a chart or a diagram), and `pixels` of embedded images by path.
 *
 * @example
 * ```ts
 * const counted: SlideWorkCache = { parts: new Map(), referenced: new Map(), pixels: new Map() };
 * ```
 */
export interface SlideWorkCache {
  parts: Map<string, PartWork>;
  referenced: Map<string, PartWork>;
  pixels: Map<string, number>;
}

interface Counting {
  limits: typeof PPTX_LIMITS;
  slideWidthPx: number;
  slideHeightPx: number;
}

const REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'embed',
  'link',
  'id',
  'pict',
  'dm',
  'lo',
  'qs',
  'cs',
]);
const IMAGE_EFFECTS: ReadonlySet<string> = new Set(['duotone', 'lum', 'biLevel']);
const EMU_PER_PX = 9525;
const NO_RELATIONSHIPS: Relationships = new Map();
const NOTHING: PartWork = { weight: 0, tabs: 0, references: [] };

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function resolvedTarget(partPath: string, target: string): string {
  const resolved = target.startsWith('/') ? [] : partPath.split('/').slice(0, -1);
  for (const segment of target.replace(/[?#][\s\S]*/, '').split(/[\\/]/)) {
    if (segment === '..') resolved.pop();
    else if (segment !== '' && segment !== '.') resolved.push(decodedSegment(segment));
  }
  return resolved.join('/');
}

function mediaPathOf(path: string): string {
  const segments = path.split('/');
  const media = segments.lastIndexOf('media');
  const inMedia = media >= 0 && media < segments.length - 1 ? segments.slice(media + 1) : segments.slice(-1);
  return `ppt/media/${inMedia.join('/')}`;
}

const parsedRoot = (xml: string | undefined): Element | null =>
  xml === undefined ? null : new DOMParser().parseFromString(xml, 'application/xml').documentElement;

const documentRootOf = (part: { spTree: { element: Element | null } } | undefined): Element | null =>
  part?.spTree.element?.ownerDocument.documentElement ?? null;

const childNamed = (element: Element | undefined, localName: string): Element | undefined =>
  element && [...element.children].find((child) => child.localName === localName);

function shareOfSide(emu: string | null | undefined, sidePx: number): number {
  const px = Number(emu) / EMU_PER_PX;
  return emu === null || emu === undefined || !Number.isFinite(px)
    ? 1
    : Math.min(Math.max(px, 0), sidePx) / sidePx;
}

function chartSlideAreasOf(chart: Element, counting: Counting): number {
  for (let ancestor = chart.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.localName === 'grpSp') return 1;
    if (ancestor.localName !== 'graphicFrame') continue;
    const extent = childNamed(childNamed(ancestor, 'xfrm'), 'ext');
    return (
      shareOfSide(extent?.getAttribute('cx'), counting.slideWidthPx) *
      shareOfSide(extent?.getAttribute('cy'), counting.slideHeightPx)
    );
  }
  return 1;
}

function referenceOf(
  element: Element,
  attribute: Attr,
  relationships: Relationships,
  partPath: string,
  counting: Counting,
): Reference | undefined {
  if (!REFERENCE_ATTRIBUTES.has(attribute.localName)) return undefined;
  const relationship = relationships.get(attribute.value);
  if (!relationship || relationship.targetMode?.trim().toLowerCase() === 'external') return undefined;
  return {
    path: resolvedTarget(partPath, relationship.target),
    hasImageEffect:
      element.localName === 'blip' &&
      [...element.children].some((child) => IMAGE_EFFECTS.has(child.localName)),
    chartSlideAreas: element.localName === 'chart' ? chartSlideAreasOf(element, counting) : 0,
  };
}

const tabsIn = (text: string): number => text.split('\t').length - 1;

function workOf(
  root: Element | null,
  relationships: Relationships,
  partPath: string,
  counting: Counting,
): PartWork {
  if (!root) return NOTHING;
  const elements = root.getElementsByTagName('*');
  const work: PartWork = { weight: elements.length + 1, tabs: 0, references: [] };
  if (elements.length >= counting.limits.slideWeight) return work;
  for (const element of [root, ...elements]) {
    if (element.localName === 'txBody') work.weight += counting.limits.textBodyWeight;
    else if (element.localName === 't') work.tabs += tabsIn(element.textContent ?? '');
    for (const attribute of element.attributes) {
      const reference = referenceOf(element, attribute, relationships, partPath, counting);
      if (reference) work.references.push(reference);
    }
  }
  return work;
}

function counted<T>(cache: Map<string, T>, path: string, count: () => T): T {
  let work = cache.get(path);
  if (work === undefined) cache.set(path, (work = count()));
  return work;
}

function partsShownBy(
  presentation: PresentationData,
  slide: SlideData,
  cache: SlideWorkCache,
  counting: Counting,
): PartWork[] {
  const layoutPath = slide.layoutIndex;
  const masterPath = presentation.layoutToMaster.get(layoutPath) ?? '';
  const layout = presentation.layouts.get(layoutPath);
  const master = presentation.masters.get(masterPath);
  return [
    counted(cache.parts, slide.slidePath, () =>
      workOf(parsedRoot(slide.sourceXml), slide.rels, slide.slidePath, counting),
    ),
    counted(cache.parts, layoutPath, () =>
      workOf(documentRootOf(layout), layout?.rels ?? NO_RELATIONSHIPS, layoutPath, counting),
    ),
    counted(cache.parts, masterPath, () =>
      workOf(documentRootOf(master), master?.rels ?? NO_RELATIONSHIPS, masterPath, counting),
    ),
  ];
}

const referencedRoot = (presentation: PresentationData, path: string): Element | null =>
  presentation.charts.get(path)?.element ?? parsedRoot(presentation.diagramDrawings?.get(path));

interface SlideTotals {
  weight: number;
  tabs: number;
  mediaBytes: number;
  effectPixels: number;
  chartSlideAreas: number;
}

function addReference(
  totals: SlideTotals,
  reference: Reference,
  presentation: PresentationData,
  cache: SlideWorkCache,
  counting: Counting,
): void {
  const shown = counted(cache.referenced, reference.path, () =>
    workOf(referencedRoot(presentation, reference.path), NO_RELATIONSHIPS, reference.path, counting),
  );
  const mediaPath = mediaPathOf(reference.path);
  const media = presentation.media.get(mediaPath);
  totals.weight += shown.weight;
  totals.tabs += shown.tabs;
  totals.mediaBytes += media?.byteLength ?? 0;
  totals.chartSlideAreas += reference.chartSlideAreas;
  if (reference.hasImageEffect && media) {
    totals.effectPixels += counted(cache.pixels, mediaPath, () => imagePixelsOf(media));
  }
}

function totalsOf(
  presentation: PresentationData,
  slide: SlideData,
  cache: SlideWorkCache,
  counting: Counting,
): SlideTotals {
  const totals: SlideTotals = { weight: 0, tabs: 0, mediaBytes: 0, effectPixels: 0, chartSlideAreas: 0 };
  for (const part of partsShownBy(presentation, slide, cache, counting)) {
    totals.weight += part.weight;
    totals.tabs += part.tabs;
    for (const reference of part.references) addReference(totals, reference, presentation, cache, counting);
  }
  return totals;
}

/**
 * Whether drawing one slide costs no more work than `limits` allows (see `PPTX_LIMITS` for each bound and
 * how it was measured), counted before the renderer draws it, over the slide, its layout and its master (the
 * renderer draws a master's shapes on every slide that uses it) and each chart, diagram and image they
 * show, once per place it is shown: the weight of their XML elements and text bodies; the tab characters in
 * their text; the bytes of embedded media; the pixels of images shown with a canvas effect (read from their
 * headers); and the area of charts, each frame counted no larger than the slide (a frame inside a group,
 * whose scale is not known here, counts as the whole slide). References are found by relationship id in any
 * namespace, as the renderer finds them. Must first run before the slide is drawn: the renderer drops a
 * slide's source XML once it has parsed it. Counts are kept in `cache`, so asking again is cheap.
 *
 * @example
 * ```ts
 * const isShown = isSlideWithinLimits(presentation, presentation.slides[index]!, cache);
 * ```
 */
export function isSlideWithinLimits(
  presentation: PresentationData,
  slide: SlideData,
  cache: SlideWorkCache,
  limits: typeof PPTX_LIMITS = PPTX_LIMITS,
): boolean {
  const counting = { limits, slideWidthPx: presentation.width, slideHeightPx: presentation.height };
  const totals = totalsOf(presentation, slide, cache, counting);
  return (
    totals.weight <= limits.slideWeight &&
    totals.tabs <= limits.slideTabs &&
    totals.mediaBytes <= limits.slideMediaBytes &&
    totals.effectPixels <= limits.slideEffectPixels &&
    totals.chartSlideAreas <= limits.slideChartAreas
  );
}
