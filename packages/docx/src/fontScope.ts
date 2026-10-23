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

/**
 * The font families one rendered document declares with `@font-face`, each renamed to a family only that
 * render uses (`prefix` + its name), so a document cannot replace a font the app uses (WebKit lets a shadow
 * root's faces into `document.fonts`). `families` maps each declared name, lower-cased, to its new quoted
 * name.
 *
 * @example
 * ```ts
 * const scope: FontScope = { prefix: 'fs-docx-1-', families: new Map([['arial', '"fs-docx-1-Arial"']]) };
 * ```
 */
export interface FontScope {
  prefix: string;
  families: Map<string, string>;
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
 * Where a kept `@font-face` rule lives, so it can be replaced: its sheet or `@media` rule, and the rule.
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
    insertRule(rule: string, index: number): number;
  };
  rule: CSSFontFaceRule;
}

function replaceWithScopedFace({ container, rule }: FontFaceInSheet, scopedFamily: string): void {
  const descriptors = [...rule.style]
    .filter((descriptor) => descriptor !== 'font-family')
    .map((descriptor) => `${descriptor}: ${rule.style.getPropertyValue(descriptor)}`);
  const index = Array.prototype.indexOf.call(container.cssRules, rule);
  container.deleteRule(index);
  container.insertRule(`@font-face { font-family: ${scopedFamily}; ${descriptors.join('; ')} }`, index);
}

/**
 * Replaces every `@font-face` in `faces` with the same face under a family scoped by `prefix` (browsers do
 * not all let a face's family be set in place), and returns the scope to apply to the rules and inline
 * styles that use them. `insertRule` takes exactly one rule, so a replacement can only be that face.
 *
 * @example
 * ```ts
 * const scope = scopeFontFaces(keptFaces, 'fs-docx-1-');
 * ```
 */
export function scopeFontFaces(faces: FontFaceInSheet[], prefix: string): FontScope {
  const families = new Map<string, string>();
  for (const face of faces) {
    const name = unquoted(face.rule.style.getPropertyValue('font-family'));
    if (name === '') continue;
    const scoped = `"${prefix}${name.replace(UNSAFE_IN_SCOPED_NAME, '-')}"`;
    families.set(name.toLowerCase(), scoped);
    replaceWithScopedFace(face, scoped);
  }
  return { prefix, families };
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
export function scopeFontFamilies(declarations: CSSStyleDeclaration, scope: FontScope): void {
  const list = declarations.getPropertyValue('font-family');
  if (list === '' || scope.families.size === 0) return;
  const scoped = familiesIn(list).map((family) => {
    const isGeneric = !QUOTED.test(family) && GENERIC_FAMILIES.has(family.toLowerCase());
    return isGeneric ? family : (scope.families.get(unquoted(family).toLowerCase()) ?? family);
  });
  declarations.setProperty('font-family', scoped.join(', '), declarations.getPropertyPriority('font-family'));
}

/**
 * Removes from `document.fonts` the faces a render scoped by `prefix` added there (WebKit adds a shadow
 * root's `@font-face` rules to the document's font set), once that render is no longer shown.
 *
 * @example
 * ```ts
 * forgetFontFaces('fs-docx-1-');
 * ```
 */
export function forgetFontFaces(prefix: string): void {
  for (const face of [...document.fonts]) {
    if (face.family.includes(prefix)) document.fonts.delete(face);
  }
}
