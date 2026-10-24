import { safeFontSource } from '@workspacekit/react/renderer-kit';

const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);
const QUOTED = /^(["'])([\s\S]*)\1$/;
const UNSAFE_IN_SCOPED_NAME = /[^\w -]/g;

const FONT_FACE_DESCRIPTORS: Readonly<Record<string, keyof FontFaceDescriptors>> = {
  'font-style': 'style',
  'font-weight': 'weight',
  'font-stretch': 'stretch',
  'unicode-range': 'unicodeRange',
  'font-feature-settings': 'featureSettings',
  'font-display': 'display',
  'ascent-override': 'ascentOverride',
  'descent-override': 'descentOverride',
  'line-gap-override': 'lineGapOverride',
};

/**
 * One `@font-face` a rendered document declared, taken out of its CSS so it can be loaded as a `FontFace`
 * that `document.fonts.delete` can remove again: its scoped `family`, its `src` as `source` (rebuilt by
 * `safeFontSource`) and its other allowed descriptors.
 *
 * @example
 * ```ts
 * const face: ScopedFontFace = { family: 'fs-docx-1-Arial', source: 'local(Menlo)', descriptors: {} };
 * ```
 */
export interface ScopedFontFace {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;
}

/**
 * The font families one rendered document declares with `@font-face`, each renamed to a family only that
 * render uses (`prefix` + its name), so a document cannot replace a font the app uses. `families` maps each
 * declared name, lower-cased, to its new quoted name; `faces` are the faces to load while it is shown.
 *
 * @example
 * ```ts
 * const families = new Map([['arial', '"fs-docx-1-Arial"']]);
 * const scope: FontScope = { prefix: 'fs-docx-1-', families, faces: [] };
 * ```
 */
export interface FontScope {
  prefix: string;
  families: Map<string, string>;
  faces: ScopedFontFace[];
}

const unquoted = (family: string): string =>
  (QUOTED.exec(family)?.[2] ?? family).replace(/\\([\s\S])/g, '$1').trim();

function familiesIn(list: string): string[] {
  const families: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const character = list[index];
    if (quote !== undefined) {
      if (character === '\\') index++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ',') {
      families.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  families.push(list.slice(start).trim());
  return families.filter((family) => family !== '');
}

/**
 * Where a kept `@font-face` rule lives, so it can be taken out: its sheet or `@media` rule, and the rule.
 *
 * @example
 * ```ts
 * const face: FontFaceInSheet = { container: sheet, rule: sheet.cssRules[0] as CSSFontFaceRule };
 * ```
 */
export interface FontFaceInSheet {
  container: {
    readonly cssRules: CSSRuleList;
    deleteRule(index: number): void;
  };
  rule: CSSFontFaceRule;
}

function takeOutOfSheet({ container, rule }: FontFaceInSheet): void {
  container.deleteRule(Array.prototype.indexOf.call(container.cssRules, rule));
}

function descriptorsOf(rule: CSSFontFaceRule): FontFaceDescriptors {
  const descriptors: Partial<Record<keyof FontFaceDescriptors, string>> = {};
  for (const property of rule.style) {
    const descriptor = FONT_FACE_DESCRIPTORS[property];
    if (descriptor) descriptors[descriptor] = rule.style.getPropertyValue(property);
  }
  return descriptors as FontFaceDescriptors;
}

/**
 * Takes every `@font-face` in `faces` out of its sheet and returns the scope to apply to the rules and
 * inline styles that use them, with each named face whose `src` keeps a source (see `safeFontSource`) under
 * a family scoped by `prefix`.
 * A face its style sheet made cannot be deleted from `document.fonts` (WebKit keeps a shadow root's faces
 * there, even once their rules are gone), so the faces are loaded as `FontFace` objects instead (see
 * `showFontFaces`).
 *
 * @example
 * ```ts
 * const scope = scopeFontFaces(keptFaces, 'fs-docx-1-');
 * ```
 */
export function scopeFontFaces(faces: FontFaceInSheet[], prefix: string): FontScope {
  const families = new Map<string, string>();
  const scopedFaces: ScopedFontFace[] = [];
  for (const face of faces) {
    const name = unquoted(face.rule.style.getPropertyValue('font-family'));
    const source = safeFontSource(face.rule.style.getPropertyValue('src'));
    const descriptors = descriptorsOf(face.rule);
    takeOutOfSheet(face);
    if (name === '') continue;
    const family = `${prefix}${name.replace(UNSAFE_IN_SCOPED_NAME, '-')}`;
    families.set(name.toLowerCase(), `"${family}"`);
    if (source !== null) scopedFaces.push({ family, source, descriptors });
  }
  return { prefix, families, faces: scopedFaces };
}

/**
 * Points a `font-family` (set directly or through `font`) at the scoped names of the families the document
 * declared. Generic families and fonts the document did not declare (the user's installed fonts) are kept.
 *
 * @example
 * ```ts
 * scopeFontFamilies(element.style, scope);
 * ```
 */
export function scopeFontFamilies(
  declarations: CSSStyleDeclaration,
  scope: Pick<FontScope, 'families'>,
): void {
  const list = declarations.getPropertyValue('font-family');
  if (list === '' || scope.families.size === 0) return;
  const scoped = familiesIn(list).map((family) => {
    const isGeneric = !QUOTED.test(family) && GENERIC_FAMILIES.has(family.toLowerCase());
    return isGeneric ? family : (scope.families.get(unquoted(family).toLowerCase()) ?? family);
  });
  declarations.setProperty('font-family', scoped.join(', '), declarations.getPropertyPriority('font-family'));
}

function fontFaceOrNull({ family, source, descriptors }: ScopedFontFace): FontFace | null {
  try {
    return new FontFace(family, source, descriptors);
  } catch {
    return null;
  }
}

/**
 * Loads `scope`'s faces into `document.fonts` as `FontFace` objects, so the shadow root that shows the
 * render can use them, and returns them for `forgetFontFaces`. Only scoped families reach the set; a face
 * the constructor refuses (an engine may throw on a value it cannot parse) is skipped, not fatal.
 *
 * @example
 * ```ts
 * const shown = showFontFaces(rendered.styles.fonts);
 * ```
 */
export function showFontFaces(scope: FontScope): FontFace[] {
  const faces = scope.faces.map(fontFaceOrNull).filter((face): face is FontFace => face !== null);
  for (const face of faces) document.fonts.add(face);
  return faces;
}

/**
 * Deletes from `document.fonts` the faces `showFontFaces` added, once their render is no longer shown.
 *
 * @example
 * ```ts
 * forgetFontFaces(shown);
 * ```
 */
export function forgetFontFaces(faces: FontFace[]): void {
  for (const face of faces) document.fonts.delete(face);
}
