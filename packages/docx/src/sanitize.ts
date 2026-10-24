import {
  confineDeclarations,
  keepWebOrMailLink,
  SVG_ANIMATION_ELEMENTS,
  svgAttributeFetches,
} from '@workspacekit/react/renderer-kit';
import DOMPurify from 'dompurify';
import { scopeFontFaces, scopeFontFamilies, type FontFaceInSheet, type FontScope } from './fontScope';

type RuleContainer = FontFaceInSheet['container'];

const FORBIDDEN_TAGS = ['iframe', 'script', 'object', 'embed', 'form', 'link', 'meta', 'base', 'style'];
const URL_ATTRIBUTES = new Set([
  'src',
  'href',
  'xlink:href',
  'poster',
  'background',
  'action',
  'formaction',
  'ping',
]);
const INLINE_OR_LOCAL = /^[ \t\n\r\f]*(?:data:|#)/i;
const INLINE_SCHEMES = ['data:', '#'];
const FONT_SOURCE_SCHEMES = ['data:'];
const SHADOW_BOUNDARY_SELECTOR = /:host|:scope|::part|::slotted|&/i;
const HOST_CSS =
  ':host{contain:paint!important;position:relative;overflow:auto}.docx-wrapper{min-width:fit-content}';

function keepOnlySafeLink(link: Element, href: string): void {
  if (href.startsWith('#')) return link.setAttribute('href', href);
  if (!keepWebOrMailLink(link, href)) link.removeAttribute('href');
}

function fetchesExternally(element: Element, name: string, value: string): boolean {
  if (URL_ATTRIBUTES.has(name)) return !INLINE_OR_LOCAL.test(value);
  return svgAttributeFetches(element, value, INLINE_SCHEMES);
}

function allowOnlyInlineReferences(node: Node): void {
  if (!(node instanceof Element)) return;
  for (const { name, value } of [...node.attributes]) {
    if (name === 'style') confineDeclarations((node as HTMLElement).style, INLINE_SCHEMES);
    else if (node.localName === 'a' && name === 'href') keepOnlySafeLink(node, value.trim());
    else if (fetchesExternally(node, name, value)) node.removeAttribute(name);
  }
}

const purifier = DOMPurify(window);
purifier.addHook('afterSanitizeAttributes', allowOnlyInlineReferences);

/**
 * Sanitizes a rendered document body in place, before it is mounted. DOMPurify drops scripts, frames,
 * objects, forms, `link`, `meta`, `base`, `style`, SVG animation elements (which could change an attribute
 * after it was checked), `srcset`, `ping` and every `on*` attribute (ids are kept as they are: the body is
 * mounted in a shadow root, where they cannot clobber the page's globals). Links keep only absolute `http:`
 * and `https:` URLs without a user name or password and `mailto:` (opened in a new tab with `noopener
 * noreferrer`) and `#bookmark` hrefs. `src`, `href`, `poster`, `background` and form actions elsewhere keep
 * only `data:` and `#` URLs (docx-preview inlines every image as `data:`; pptx's `confineSlide` allows
 * `blob:` and `data:` on media only, because its renderer uses object URLs). An SVG attribute holding a CSS
 * escape is removed (`u\72l(` is `url(` to the CSS parser), as is one that would fetch. Inline styles lose
 * any declaration that would fetch (`url()` other than `data:`, `image-set()`), any `position` other than
 * exactly `static`, `relative` or `absolute`, and any `z-index` that is not an integer up to 1000 (so `var()`
 * and `calc()` cannot smuggle `fixed` or a high stack in), so nothing leaves the viewer's box.
 *
 * @example
 * ```ts
 * sanitizeBody(renderedBody);
 * shadowRoot.replaceChildren(...renderedBody.childNodes);
 * ```
 */
export function sanitizeBody(body: HTMLElement): void {
  purifier.sanitize(body, {
    IN_PLACE: true,
    FORBID_TAGS: [...FORBIDDEN_TAGS, ...SVG_ANIMATION_ELEMENTS],
    FORBID_ATTR: ['srcset'],
    SANITIZE_DOM: false,
  });
}

const isContainedStyleRule = (rule: CSSRule): rule is CSSStyleRule =>
  rule instanceof CSSStyleRule &&
  !SHADOW_BOUNDARY_SELECTOR.test(rule.selectorText) &&
  !('cssRules' in rule && rule.cssRules.length > 0);

interface KeptRules {
  declarations: CSSStyleDeclaration[];
  fontFaces: FontFaceInSheet[];
}

function keepSafeRules(container: RuleContainer, kept: KeptRules): void {
  for (let index = container.cssRules.length - 1; index >= 0; index--) {
    const rule = container.cssRules[index]!;
    if (rule instanceof CSSNamespaceRule) continue;
    if (rule instanceof CSSMediaRule) {
      keepSafeRules(rule, kept);
      if (rule.cssRules.length === 0) container.deleteRule(index);
    } else if (isContainedStyleRule(rule)) kept.declarations.push(rule.style);
    else if (rule instanceof CSSFontFaceRule) kept.fontFaces.push({ container, rule });
    else if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) kept.declarations.push((frame as CSSKeyframeRule).style);
    } else container.deleteRule(index);
  }
}

function fontFacesInDocumentOrder(
  sheet: CSSStyleSheet,
  declarations: CSSStyleDeclaration[],
): FontFaceInSheet[] {
  const kept: KeptRules = { declarations, fontFaces: [] };
  keepSafeRules(sheet, kept);
  return kept.fontFaces.reverse();
}

const canConstructStyleSheets = (): boolean => 'adoptedStyleSheets' in Document.prototype;

function parsedSheet(cssText: string, inert: Document): CSSStyleSheet {
  if (canConstructStyleSheets()) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    return sheet;
  }
  const style = inert.createElement('style');
  style.textContent = cssText;
  inert.head.append(style);
  return style.sheet!;
}

function serializedAndDetached(sheet: CSSStyleSheet): string {
  const text = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
  sheet.ownerNode?.remove();
  return text;
}

/**
 * A rendered document's styles, ready for its shadow root: constructed `sheets` to adopt, or, where the
 * browser cannot construct style sheets (Safari before 16.4), one `element` to mount instead; and the
 * scope its font families were renamed into, to apply to inline styles too, with the faces to load.
 *
 * @example
 * ```ts
 * const styles: DocumentStyles = safeStyles(cssTexts, inertDocument, 'fs-docx-1-');
 * ```
 */
export interface DocumentStyles {
  sheets: CSSStyleSheet[];
  element: HTMLStyleElement | null;
  fonts: FontScope;
}

/**
 * Turns CSS from a rendered document into styles that cannot fetch or reach outside the viewer, led by the
 * viewer's own `:host` rules (paint containment, `!important`, so nothing is drawn outside its box). The CSS
 * is parsed by the browser (in `inert` when style sheets cannot be constructed, where `@import` fetches
 * nothing), then only style rules, `@media`, `@keyframes` and `@namespace` (inert, and not removable) are
 * kept. Every other at-rule goes (`@import`, `@scope`, `@layer`, `@supports`, `@container`, `@property` and
 * any unknown one), as do style rules with nested rules or whose selector names `:host`, `:scope`, `::part`,
 * `::slotted` or `&`. Declarations are confined as in `sanitizeBody`. Every `@font-face` is taken out of the
 * CSS into `fonts.faces`, its family renamed under `fontPrefix` (with the rules that use it) and its `src`
 * confined the same way but with `data:` as the only `url()` it keeps (then rebuilt by `safeFontSource`), for
 * `showFontFaces` to load.
 *
 * @example
 * ```ts
 * const { sheets, element, fonts } = safeStyles([style.textContent], inertDocument, 'fs-docx-1-');
 * ```
 */
export function safeStyles(cssTexts: string[], inert: Document, fontPrefix: string): DocumentStyles {
  const sheets = cssTexts.map((cssText) => parsedSheet(cssText, inert));
  const declarations: CSSStyleDeclaration[] = [];
  const fontFaces = sheets.flatMap((sheet) => fontFacesInDocumentOrder(sheet, declarations));
  for (const style of declarations) confineDeclarations(style, INLINE_SCHEMES);
  for (const { rule } of fontFaces) confineDeclarations(rule.style, FONT_SOURCE_SCHEMES);
  const fonts = scopeFontFaces(fontFaces, fontPrefix);
  for (const style of declarations) scopeFontFamilies(style, fonts);
  if (canConstructStyleSheets()) {
    const host = new CSSStyleSheet();
    host.replaceSync(HOST_CSS);
    return { sheets: [host, ...sheets], element: null, fonts };
  }
  const element = inert.createElement('style');
  element.textContent = [HOST_CSS, ...sheets.map(serializedAndDetached)].join('\n');
  return { sheets: [], element, fonts };
}
