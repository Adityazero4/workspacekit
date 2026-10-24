import { parseAsync, renderDocument } from 'docx-preview';
import { forgetFontFaces, scopeFontFamilies, showFontFaces, type FontScope } from './fontScope';
import { DOCX_LIMITS, repackWithinLimits } from './limits';
import { assertRenderWithinLimits, type ParsedDocx } from './renderedWork';
import { safeStyles, sanitizeBody, type DocumentStyles } from './sanitize';
import { replaceSymbolFonts } from './symbolFonts';

/**
 * A document rendered, sanitized and ready to mount: the body's nodes and its styles.
 *
 * @example
 * ```ts
 * const rendered: RenderedDocx = await renderDocx(buffer, signal);
 * ```
 */
export interface RenderedDocx {
  nodes: Node[];
  styles: DocumentStyles;
}

const RENDER_OPTIONS = { renderAltChunks: false, useBase64URL: true, inWrapper: true, breakPages: true };

interface ElementSpec {
  ns?: string;
  tagName: string;
  className?: string;
  style?: Record<string, string> | string;
  children?: ElementDescription[];
  [property: string]: unknown;
}

type ElementDescription = ElementSpec | Node | string;

function inertElementFactory(inert: Document): (description: ElementDescription) => Node {
  const create = (description: ElementDescription): Node => {
    if (typeof description === 'string') return inert.createTextNode(description);
    if (description instanceof Node) return description;
    const { ns, tagName, className, style, children, ...properties } = description;
    if (tagName.startsWith('#')) return inert.createComment('');
    const element = ns ? inert.createElementNS(ns, tagName) : inert.createElement(tagName);
    if (className) element.setAttribute('class', className);
    if (typeof style === 'string') element.setAttribute('style', style);
    else Object.assign((element as HTMLElement).style, style);
    for (const [key, value] of Object.entries(properties)) {
      if (value !== undefined) Object.assign(element, { [key]: value });
    }
    for (const child of children ?? []) element.appendChild(create(child));
    return element;
  };
  return create;
}

let renders = 0;

const unguessablePart = (): string => crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36);

function scopeInlineFonts(body: HTMLElement, fonts: FontScope): void {
  for (const element of body.querySelectorAll<HTMLElement>('[style*="font"]')) {
    scopeFontFamilies(element.style, fonts);
  }
}

function unwrapTextBoxes(body: HTMLElement): void {
  for (const drawing of body.querySelectorAll('svg:has(foreignObject)')) {
    const block = body.ownerDocument.createElement('div');
    for (const box of drawing.querySelectorAll('foreignObject')) block.append(...box.childNodes);
    drawing.replaceWith(block);
  }
}

/**
 * Renders a `.docx` with docx-preview into an inert document, so nothing it builds can load a resource or
 * run a handler, then sanitizes the result before anyone mounts it. The archive is first repacked within
 * `limits`, and the parsed document is counted against them before it is rendered. Embedded HTML
 * (`altChunk`) is never rendered, images become `data:` URLs, VML text boxes become plain blocks (their SVG
 * wrapper would be dropped by the sanitizer), the document's own fonts are renamed for this render alone
 * (`fs-docx-<n>-<random>-<name>`, so a document cannot aim at another render's faces), and Symbol and
 * Wingdings text becomes Unicode. Rejects with `DocumentLimitExceeded` for a document over the limits, with
 * the signal's reason when aborted (checked between steps; nothing rendered is kept), or with docx-preview's
 * error.
 *
 * @example
 * ```ts
 * const { nodes, styles } = await renderDocx(buffer, controller.signal);
 * ```
 */
export async function renderDocx(
  data: ArrayBuffer,
  signal: AbortSignal,
  limits: typeof DOCX_LIMITS = DOCX_LIMITS,
): Promise<RenderedDocx> {
  const { archive, fileSizes } = repackWithinLimits(new Uint8Array(data), limits);
  signal.throwIfAborted();
  const parsed = (await parseAsync(archive, RENDER_OPTIONS)) as ParsedDocx;
  signal.throwIfAborted();
  assertRenderWithinLimits(parsed, fileSizes, limits);
  const inert = document.implementation.createHTMLDocument('');
  const rendered = await renderDocument(parsed, { ...RENDER_OPTIONS, h: inertElementFactory(inert) });
  signal.throwIfAborted();
  const cssTexts = rendered
    .filter((node) => node.nodeName === 'STYLE')
    .map((style) => style.textContent ?? '');
  const styles = safeStyles(cssTexts, inert, `fs-docx-${++renders}-${unguessablePart()}-`);
  const body = inert.createElement('div');
  body.append(...rendered.filter((node) => node.nodeName !== 'STYLE'));
  unwrapTextBoxes(body);
  sanitizeBody(body);
  scopeInlineFonts(body, styles.fonts);
  replaceSymbolFonts(body);
  return { nodes: [...body.childNodes], styles };
}

const shownFontFaces = new WeakMap<ShadowRoot, FontFace[]>();

/**
 * Mounts a rendered document in `shadowRoot`, replacing what it showed; `null` empties it. The document's
 * scoped font faces are in `document.fonts` only while it is shown: those of the render it replaces are
 * deleted from the set (see `showFontFaces`).
 *
 * @example
 * ```ts
 * showRendered(host.shadowRoot!, null);
 * ```
 */
export function showRendered(shadowRoot: ShadowRoot, rendered: RenderedDocx | null): void {
  forgetFontFaces(shownFontFaces.get(shadowRoot) ?? []);
  shownFontFaces.set(shadowRoot, rendered ? showFontFaces(rendered.styles.fonts) : []);
  const styleElement = rendered?.styles.element;
  shadowRoot.replaceChildren(...(styleElement ? [styleElement] : []), ...(rendered?.nodes ?? []));
  shadowRoot.adoptedStyleSheets = rendered?.styles.sheets ?? [];
}

/**
 * Handles a click inside the rendered document: a `#bookmark` link scrolls to the element with that id in
 * the same shadow root (never one of the app's) by scrolling the shadow host alone, so neither the page URL
 * nor the app's own scroll position changes, and moves focus to it, as following a fragment link does.
 *
 * @example
 * ```ts
 * shadowRoot.addEventListener('click', (event) => followBookmark(event, shadowRoot));
 * ```
 */
export function followBookmark(event: Event, shadowRoot: ShadowRoot): void {
  const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (!link) return;
  event.preventDefault();
  const target = shadowRoot.getElementById(link.getAttribute('href')!.slice(1));
  if (!target) return;
  const scroller = shadowRoot.host;
  scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}
