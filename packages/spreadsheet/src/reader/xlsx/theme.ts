import type { ReadWork, ReaderCaps } from '../types';
import { attribute, readXmlPart } from './xml';
import type { ZipArchive } from './zip';

const SCHEME_ORDER = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
];
const THEME_INDEX_TO_SCHEME = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11];
const INDEXED_PALETTE =
  '000000FFFFFFFF000000FF000000FFFFFF00FF00FF00FFFF000000FFFFFFFF000000FF000000FFFFFF00FF00FF00FFFF' +
  '800000008000000080808000800080008080C0C0C08080809999FF993366FFFFCCCCFFFF660066FF80800066CCCCCCFF' +
  '000080FF00FFFFFF0000FFFF8000808000000080800000FF00CCFFCCFFFFCCFFCCFFFF9999CCFFFF99CCCC99FFFFCC99' +
  '3366FF33CCCC99CC00FFCC00FF9900FF6600666699969696003366339966003300333300993300993366333399333333';
const HEX_DIGITS_PER_COLOUR = 6;

/**
 * A colour as a workbook writes it: an `rgb` (ARGB hex), a `theme` index or an `indexed` palette entry,
 * each optionally lightened or darkened by `tint` (-1 to 1).
 *
 * @example
 * ```ts
 * const accent: ColorReference = { theme: 4, tint: 0.4 };
 * ```
 */
export interface ColorReference {
  rgb?: string;
  theme?: number;
  indexed?: number;
  tint?: number;
}

/**
 * Reads a colour element's attributes (`<color rgb="FF0000FF"/>`, `<fgColor theme="4" tint="0.4"/>`).
 *
 * @example
 * ```ts
 * colorReferenceOf({ theme: '4', tint: '0.4' }); // { theme: 4, tint: 0.4 }
 * ```
 */
export function colorReferenceOf(attributes: Record<string, string>): ColorReference {
  const numberOf = (name: string): number | undefined => {
    const value = attribute(attributes, name);
    return value === undefined ? undefined : Number(value);
  };
  return {
    rgb: attribute(attributes, 'rgb'),
    theme: numberOf('theme'),
    indexed: numberOf('indexed'),
    tint: numberOf('tint'),
  };
}

/**
 * Reads the workbook theme's colour scheme, as hex colours (`RRGGBB`) indexed the way cells refer to them
 * (0 is light 1, 1 is dark 1, 2 is light 2, 3 is dark 2, then the accents and links).
 *
 * @example
 * ```ts
 * const themeColors = readThemeColors(archive, 'xl/theme/theme1.xml', work, DEFAULT_CAPS);
 * ```
 */
export function readThemeColors(
  archive: ZipArchive,
  path: string,
  work: ReadWork,
  caps: ReaderCaps,
): string[] {
  const scheme = new Map<string, string>();
  let current: string | undefined;
  let isDone = false;
  readXmlPart(
    archive,
    path,
    {
      open: (name, attributes) => {
        if (SCHEME_ORDER.includes(name)) current = name;
        else if (current && name === 'srgbClr') scheme.set(current, attribute(attributes, 'val') ?? '');
        else if (current && name === 'sysClr') scheme.set(current, attribute(attributes, 'lastClr') ?? '');
      },
      close: (name) => {
        if (name === current) current = undefined;
        if (name === 'clrScheme') isDone = true;
      },
      isDone: () => isDone,
    },
    work,
    caps,
    true,
  );
  return THEME_INDEX_TO_SCHEME.map((schemeIndex) => scheme.get(SCHEME_ORDER[schemeIndex]!) ?? '');
}

function hexToRgb(hex: string): Triple {
  return [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255) as Triple;
}

type Triple = [number, number, number];

function rgbToHsl([red, green, blue]: Triple): Triple {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const spread = max - min;
  const saturation = lightness > 0.5 ? spread / (2 - max - min) : spread / (max + min);
  const hue =
    max === red
      ? (green - blue) / spread + (green < blue ? 6 : 0)
      : max === green
        ? (blue - red) / spread + 2
        : (red - green) / spread + 4;
  return [hue / 6, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]: Triple): Triple {
  if (saturation === 0) return [lightness, lightness, lightness];
  const upper =
    lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const lower = 2 * lightness - upper;
  const channel = (offset: number): number => {
    const turn = (hue + offset + 1) % 1;
    if (turn < 1 / 6) return lower + (upper - lower) * 6 * turn;
    if (turn < 1 / 2) return upper;
    if (turn < 2 / 3) return lower + (upper - lower) * (2 / 3 - turn) * 6;
    return lower;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

function applyTint(hex: string, tint: number): string {
  const [hue, saturation, lightness] = rgbToHsl(hexToRgb(hex));
  const tinted = tint < 0 ? lightness * (1 + tint) : lightness * (1 - tint) + tint;
  return hslToRgb([hue, saturation, tinted])
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
}

function baseHex(reference: ColorReference, themeColors: readonly string[]): string | undefined {
  if (reference.rgb !== undefined) return reference.rgb.length === 8 ? reference.rgb.slice(2) : reference.rgb;
  if (reference.theme !== undefined) return themeColors[reference.theme] || undefined;
  if (reference.indexed !== undefined) {
    const start = reference.indexed * HEX_DIGITS_PER_COLOUR;
    return start < INDEXED_PALETTE.length
      ? INDEXED_PALETTE.slice(start, start + HEX_DIGITS_PER_COLOUR)
      : undefined;
  }
  return undefined;
}

const isHexColour = (hex: string): boolean =>
  hex.length === HEX_DIGITS_PER_COLOUR && [...hex].every((digit) => '0123456789abcdefABCDEF'.includes(digit));

/**
 * The CSS colour (`#rrggbb`) a colour reference stands for, or `undefined` when it names nothing usable.
 *
 * @example
 * ```ts
 * cssColorOf({ rgb: 'FF336699' }, []); // '#336699'
 * ```
 */
export function cssColorOf(
  reference: ColorReference | undefined,
  themeColors: readonly string[],
): string | undefined {
  const hex = reference && baseHex(reference, themeColors);
  if (!hex || !isHexColour(hex)) return undefined;
  return `#${(reference.tint ? applyTint(hex, reference.tint) : hex).toLowerCase()}`;
}
