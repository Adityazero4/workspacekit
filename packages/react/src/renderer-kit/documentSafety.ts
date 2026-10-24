import { safeUrlOrNull } from '../renderers/safeUrls';

const URL_FUNCTION = 'url(';
const CSS_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\f']);
const CONTAINED_POSITIONS: ReadonlySet<string> = new Set(['static', 'relative', 'absolute']);
const INTEGER = /^[+-]?\d+$/;
const HIGHEST_Z_INDEX = 1000;
const WEB_OR_MAIL_LINK = /^(?:https?:\/\/|mailto:)/i;
const MAIL_LINK = /^mailto:/i;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * The SVG animation (SMIL) elements a document sanitizer removes, lower-cased and frozen: each could change
 * an attribute after it was checked.
 *
 * @example
 * ```ts
 * purifier.sanitize(body, { FORBID_TAGS: ['script', ...SVG_ANIMATION_ELEMENTS] });
 * ```
 */
export const SVG_ANIMATION_ELEMENTS: readonly string[] = Object.freeze([
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
  'animatecolor',
  'mpath',
  'discard',
]);

function afterWhitespace(text: string, index: number): number {
  let next = index;
  while (next < text.length && CSS_WHITESPACE.has(text[next]!)) next++;
  return next;
}

function cssValueFetches(value: string, localSchemes: readonly string[]): boolean {
  const text = value.toLowerCase();
  if (text.includes('image-set(')) return true;
  for (let at = text.indexOf(URL_FUNCTION); at !== -1; at = text.indexOf(URL_FUNCTION, at + 1)) {
    let target = afterWhitespace(text, at + URL_FUNCTION.length);
    if (text[target] === '"' || text[target] === "'") target = afterWhitespace(text, target + 1);
    if (!localSchemes.some((scheme) => text.startsWith(scheme, target))) return true;
  }
  return false;
}

function isAllowedDeclaration(property: string, value: string, localSchemes: readonly string[]): boolean {
  if (cssValueFetches(value, localSchemes) || (property.startsWith('--') && value.includes('\\'))) {
    return false;
  }
  if (property === 'position') return CONTAINED_POSITIONS.has(value.trim().toLowerCase());
  return property !== 'z-index' || (INTEGER.test(value.trim()) && Number(value) <= HIGHEST_Z_INDEX);
}

/**
 * Removes from `declarations` (an inline style, or a rule's) every declaration that could fetch or reach
 * outside the viewer's box: a `url()` whose target does not start with one of `localSchemes`, any
 * `image-set()`, a custom property holding a CSS escape, any `position` other than exactly `static`,
 * `relative` or `absolute`, and any `z-index` that is not an integer up to 1000 (so `var()` and `calc()`
 * cannot smuggle `fixed` or a high stack in). Scanning a value for `url(` is linear in its length, and skips
 * only CSS whitespace (space, tab, line feed, carriage return, form feed): a no-break space before `data:`
 * makes a relative URL, which would fetch from the app's origin. Each entry of `localSchemes` must be a
 * whole lower-case scheme with its colon (`'data:'`, `'blob:'`) or `'#'`: it is matched as a prefix, so an
 * entry such as `''` or `'h'` would let every `url()` through.
 *
 * @example
 * ```ts
 * confineDeclarations(element.style, ['data:', '#']);
 * ```
 */
export function confineDeclarations(
  declarations: CSSStyleDeclaration,
  localSchemes: readonly string[],
): void {
  for (const property of [...declarations]) {
    if (!isAllowedDeclaration(property, declarations.getPropertyValue(property), localSchemes)) {
      declarations.removeProperty(property);
    }
  }
}

/**
 * Whether an attribute `value` on `element` could fetch through CSS: on an SVG element, a value holding a
 * CSS escape (`u\72l(` is `url(` to the CSS parser) or a `url()` whose target does not start with one of
 * `localSchemes` (whole schemes or `'#'`, as in `confineDeclarations`). Always `false` for an element
 * outside SVG.
 *
 * @example
 * ```ts
 * if (svgAttributeFetches(element, attribute.value, ['data:', '#'])) element.removeAttributeNode(attribute);
 * ```
 */
export function svgAttributeFetches(
  element: Element,
  value: string,
  localSchemes: readonly string[],
): boolean {
  if (element.namespaceURI !== SVG_NAMESPACE) return false;
  return value.includes('\\') || cssValueFetches(value, localSchemes);
}

function webOrMailLinkOrNull(href: string): string | null {
  if (!WEB_OR_MAIL_LINK.test(href)) return null;
  if (MAIL_LINK.test(href)) return href;
  const allowed = safeUrlOrNull(href);
  if (allowed === null) return null;
  const { username, password } = new URL(allowed);
  return username || password ? null : allowed;
}

function setAttributeIfDifferent(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/**
 * Keeps `link` only as a link to a web page or a mail client: when `href` (trimmed) is a `mailto:` link, or
 * an absolute `http:` or `https:` URL without a user name or password, points `link` at it (the absolute
 * form) with `target="_blank"` and `rel="noopener noreferrer"`, and returns `true`. For anything else
 * (`javascript:`, `data:`, `file:`, a relative URL) it changes nothing and returns `false`, and the caller
 * removes the `href`. Each attribute is set only when its value changes, so a `MutationObserver` that calls
 * this never feeds itself.
 *
 * @example
 * ```ts
 * if (!keepWebOrMailLink(link, link.getAttribute('href')!)) link.removeAttribute('href');
 * ```
 */
export function keepWebOrMailLink(link: Element, href: string): boolean {
  const allowed = webOrMailLinkOrNull(href.trim());
  if (allowed === null) return false;
  setAttributeIfDifferent(link, 'href', allowed);
  setAttributeIfDifferent(link, 'target', '_blank');
  setAttributeIfDifferent(link, 'rel', 'noopener noreferrer');
  return true;
}

function topLevelSources(list: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const character = list[index];
    if (character === '\\') index++;
    else if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter((part) => part !== '');
}

const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(\n)|([\s\S]))/gi;
const FONT_FUNCTION =
  /([a-z-]+)\((?=(\s*))\2("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|(?:[^()"'\\\s]|\\(?=([0-9a-f]{1,6}[ \t\n\r\f]?))\4|\\[^\n0-9a-f])*)\s*\)\s*/iy;
const DATA_URL = /^data:/i;
const LOCAL_FONT_NAME = /^[\p{L}\p{N} ._-]+$/u;
const FORMAT_NAME = /^[a-z0-9-]+$/i;
const TECH_KEYWORD = /^(?:variations|palettes|incremental|(?:color|features)-[a-z0-9]+)$/i;
const REPLACEMENT_CHARACTER = 0xfffd;
const CHARACTERS_TO_ESCAPE = /["\\]|[^ -~\u0080-\uffff]/g;
const HIGHEST_CODE_POINT = 0x10ffff;
const ALLOWED_AFTER_URL: ReadonlySet<string> = new Set(['', 'format', 'tech', 'format tech']);

interface FontSourceFunction {
  name: string;
  argument: string;
}

const isSurrogate = (codePoint: number): boolean => codePoint >= 0xd800 && codePoint <= 0xdfff;

const escapedCodePoint = (hex: string): string => {
  const codePoint = parseInt(hex, 16);
  const isValid = codePoint !== 0 && codePoint <= HIGHEST_CODE_POINT && !isSurrogate(codePoint);
  return String.fromCodePoint(isValid ? codePoint : REPLACEMENT_CHARACTER);
};

const unescapedCss = (text: string): string =>
  text.replace(CSS_ESCAPE, (_, hex?: string, newline?: string, character?: string) =>
    hex ? escapedCodePoint(hex) : newline ? '' : character!,
  );

const unquotedArgument = (argument: string): string =>
  unescapedCss(/^["']/.test(argument) ? argument.slice(1, -1) : argument);

const quotedCss = (text: string): string =>
  `"${text.replace(CHARACTERS_TO_ESCAPE, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}"`;

function functionsIn(component: string): FontSourceFunction[] | null {
  const functions: FontSourceFunction[] = [];
  FONT_FUNCTION.lastIndex = 0;
  while (FONT_FUNCTION.lastIndex < component.length) {
    const match = FONT_FUNCTION.exec(component);
    if (!match) return null;
    functions.push({ name: match[1]!.toLowerCase(), argument: unquotedArgument(match[3]!) });
  }
  return functions;
}

const rebuiltModifier = ({ name, argument }: FontSourceFunction): string =>
  name === 'format' ? `format(${quotedCss(argument)})` : `tech(${argument})`;

function rebuiltUrlSource(url: string, modifiers: FontSourceFunction[]): string | null {
  const isAllowedOrder = ALLOWED_AFTER_URL.has(modifiers.map(({ name }) => name).join(' '));
  const areNames = modifiers.every(({ name, argument }) =>
    (name === 'format' ? FORMAT_NAME : TECH_KEYWORD).test(argument),
  );
  if (!DATA_URL.test(url) || !isAllowedOrder || !areNames) return null;
  return [`url(${quotedCss(url)})`, ...modifiers.map(rebuiltModifier)].join(' ');
}

function rebuiltSource(component: string): string | null {
  const [first, ...modifiers] = functionsIn(component) ?? [];
  if (first?.name === 'url') return rebuiltUrlSource(first.argument, modifiers);
  const isLocalFont = first?.name === 'local' && modifiers.length === 0;
  return isLocalFont && LOCAL_FONT_NAME.test(first.argument) ? `local(${quotedCss(first.argument)})` : null;
}

/**
 * A font face's `src`, rebuilt from an allow-list, or `null` when nothing in it is allowed. Each
 * comma-separated source is parsed (quotes and CSS escapes resolved) and kept only when it is
 * `local(<name>)` (letters, digits, spaces, `.`, `_` and `-`), or `url()` whose parsed URL starts with
 * `data:`, optionally followed by one `format(<name>)` (ASCII letters, digits and `-`) and then one
 * `tech(<keyword>)` (`variations`, `palettes`, `incremental`, `color-*` or `features-*`). Anything else
 * (another scheme, a nested or unknown function, `image-set()`, a stray token) drops that source, and
 * unbalanced parentheses drop the whole list. The result is written fresh, with every string quoted and
 * escaped, so only what was checked reaches `new FontFace`.
 *
 * @example
 * ```ts
 * safeFontSource('url(https://evil.example/f.woff), local(Menlo)'); // 'local("Menlo")'
 * ```
 */
export function safeFontSource(source: string): string | null {
  const kept = topLevelSources(source)
    .map(rebuiltSource)
    .filter((rebuilt): rebuilt is string => rebuilt !== null);
  return kept.length > 0 ? kept.join(', ') : null;
}
