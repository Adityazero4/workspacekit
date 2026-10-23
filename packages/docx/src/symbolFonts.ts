const SYMBOL_GLYPHS: readonly (readonly [number, string])[] = [
  [0x20, ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼'],
  [0xa0, '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪'],
  [0xf1, '⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭'],
];

const WINGDINGS_GLYPHS: readonly (readonly [number, string])[] = [
  [0x46, '☞'],
  [0x6c, '●🔾■□🞐❑❒⬧⧫◆❖⬥⌧'],
  [0x9e, '·•▪⚪🞆🞈◉◎🔿▪◻'],
  [0xd8, '➢'],
  [0xef, '⇦⇨⇧⇩'],
  [0xfb, '✗✔☒☑'],
];

const glyphTable = (segments: readonly (readonly [number, string])[]): Map<number, string> =>
  new Map(segments.flatMap(([first, glyphs]) => [...glyphs].map((glyph, index) => [first + index, glyph])));

const TABLES: Record<string, Map<number, string>> = {
  symbol: glyphTable(SYMBOL_GLYPHS),
  wingdings: glyphTable(WINGDINGS_GLYPHS),
};
const PRIVATE_USE_OFFSET = 0xf000;
const SYMBOL_FONT_CHARACTER = /[\u0020-\u00FF\uF020-\uF0FF]/;
const isQuote = (character: string | undefined): boolean => character === '"' || character === "'";

function firstFamilyOf(fontFamily: string): string {
  const first = fontFamily.slice(0, fontFamily.includes(',') ? fontFamily.indexOf(',') : undefined).trim();
  const start = isQuote(first[0]) ? 1 : 0;
  const end = first.length > start && isQuote(first.at(-1)) ? first.length - 1 : first.length;
  return first.slice(start, end).trim().toLowerCase();
}

/**
 * The Unicode text a run in the Symbol or Wingdings font shows: those fonts draw their glyphs at character
 * codes 0x20 to 0xFF (Word stores them there, or at the same codes in the private-use area from U+F020), so
 * `abp` in Symbol is `αβπ`. Symbol is mapped in full; Wingdings only for the bullets, check boxes and arrows
 * Word lists use, each to the nearest widely available Unicode character.
 * `null` when the first font of `fontFamily` is neither, or when a character has no mapping, so the caller
 * keeps the original font.
 *
 * @example
 * ```ts
 * unicodeOfSymbolText('Wingdings', '\uF0FC'); // '✔'
 * ```
 */
export function unicodeOfSymbolText(fontFamily: string, text: string): string | null {
  const table = TABLES[firstFamilyOf(fontFamily)];
  if (!table) return null;
  let unicode = '';
  for (const character of text) {
    const glyph = SYMBOL_FONT_CHARACTER.test(character)
      ? table.get(character.charCodeAt(0) % PRIVATE_USE_OFFSET)
      : undefined;
    if (glyph === undefined) return null;
    unicode += glyph;
  }
  return unicode;
}

/**
 * Rewrites every element under `root` whose own font is Symbol or Wingdings to the Unicode characters its
 * text shows, in Arial, so the document reads the same where those fonts are not installed. An element with
 * a character that has no mapping keeps its font.
 *
 * @example
 * ```ts
 * replaceSymbolFonts(renderedBody);
 * ```
 */
export function replaceSymbolFonts(root: Element): void {
  for (const element of root.querySelectorAll<HTMLElement>('[style*="font-family"]')) {
    const text = element.childElementCount === 0 ? element.textContent : null;
    const unicode = text && unicodeOfSymbolText(element.style.fontFamily, text);
    if (!unicode) continue;
    element.textContent = unicode;
    element.style.fontFamily = 'Arial';
  }
}
