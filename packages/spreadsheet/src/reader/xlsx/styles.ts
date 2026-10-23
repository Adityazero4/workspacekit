import type { CellStyle } from '../../grid/model';
import { fontPoints } from '../geometry';
import type { CellFormat, ReadWork, ReaderCaps } from '../types';
import { colorReferenceOf, cssColorOf, type ColorReference } from './theme';
import { attribute, readXmlPart } from './xml';
import type { ZipArchive } from './zip';

const MOST_STYLE_RECORDS = 65_536;

interface Font {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size?: number;
  color?: ColorReference;
}

interface CellXf {
  numFmtId: number;
  fontId: number;
  fillId: number;
  horizontal?: string;
  wrapText: boolean;
  shrinkToFit: boolean;
}

interface RawStyles {
  numFmts: Map<number, string>;
  fonts: Font[];
  fills: (ColorReference | undefined)[];
  cellXfs: CellXf[];
}

/**
 * The cell formats of a workbook, by the style index (`s`) a cell carries: the number format code that
 * turns its value into text, and its look.
 *
 * @example
 * ```ts
 * styles.numberFormatOf(3); // '#,##0.00'
 * ```
 */
export interface WorkbookStyles {
  numberFormatOf: (styleIndex: number) => number | string;
  formatOf: (styleIndex: number) => CellFormat;
}

const isOn = (attributes: Record<string, string>): boolean => {
  const value = attribute(attributes, 'val');
  return value !== '0' && value !== 'false';
};

function onFontChild(font: Font, name: string, attributes: Record<string, string>): void {
  if (name === 'b') font.bold = isOn(attributes);
  else if (name === 'i') font.italic = isOn(attributes);
  else if (name === 'strike') font.strike = isOn(attributes);
  else if (name === 'u') font.underline = attribute(attributes, 'val') !== 'none';
  else if (name === 'sz') font.size = fontPoints(Number(attribute(attributes, 'val')));
  else if (name === 'color') font.color = colorReferenceOf(attributes);
}

function newXf(attributes: Record<string, string>): CellXf {
  const id = (name: string): number => Number(attribute(attributes, name) ?? 0);
  return {
    numFmtId: id('numFmtId'),
    fontId: id('fontId'),
    fillId: id('fillId'),
    wrapText: false,
    shrinkToFit: false,
  };
}

function styleCollector(styles: RawStyles) {
  let section = '';
  let isSolidFill = false;
  return {
    open: (name: string, attributes: Record<string, string>): void => {
      if (name === 'numFmts' || name === 'fonts' || name === 'fills' || name === 'cellXfs') section = name;
      else if (section === 'numFmts' && name === 'numFmt') {
        styles.numFmts.set(
          Number(attribute(attributes, 'numFmtId')),
          attribute(attributes, 'formatCode') ?? 'General',
        );
      } else if (section === 'fonts' && name === 'font') {
        styles.fonts.push({ bold: false, italic: false, underline: false, strike: false });
      } else if (section === 'fonts') onFontChild(styles.fonts.at(-1)!, name, attributes);
      else if (section === 'fills' && name === 'fill') styles.fills.push(undefined);
      else if (section === 'fills' && name === 'patternFill') {
        isSolidFill = attribute(attributes, 'patternType') === 'solid';
      } else if (section === 'fills' && name === 'fgColor' && isSolidFill) {
        styles.fills[styles.fills.length - 1] = colorReferenceOf(attributes);
      } else if (section === 'cellXfs' && name === 'xf') styles.cellXfs.push(newXf(attributes));
      else if (section === 'cellXfs' && name === 'alignment') {
        const xf = styles.cellXfs.at(-1)!;
        xf.horizontal = attribute(attributes, 'horizontal');
        xf.wrapText =
          attribute(attributes, 'wrapText') === '1' || attribute(attributes, 'wrapText') === 'true';
        xf.shrinkToFit =
          attribute(attributes, 'shrinkToFit') === '1' || attribute(attributes, 'shrinkToFit') === 'true';
      }
    },
    close: (name: string): void => {
      if (name === section) section = '';
    },
    isDone: (): boolean =>
      styles.fonts.length > MOST_STYLE_RECORDS ||
      styles.fills.length > MOST_STYLE_RECORDS ||
      styles.cellXfs.length > MOST_STYLE_RECORDS,
  };
}

const ALIGNMENTS: Record<string, CellFormat['align']> = {
  left: 'left',
  center: 'center',
  centerContinuous: 'center',
  right: 'right',
};

function cellStyleOf(xf: CellXf, styles: RawStyles, themeColors: readonly string[]): CellStyle | undefined {
  const font = styles.fonts[xf.fontId];
  const defaultColor = cssColorOf(styles.fonts[0]?.color, themeColors);
  const color = cssColorOf(font?.color, themeColors);
  const style: CellStyle = {
    bold: font?.bold || undefined,
    italic: font?.italic || undefined,
    underline: font?.underline || undefined,
    strike: font?.strike || undefined,
    color: color === defaultColor ? undefined : color,
    fill: cssColorOf(styles.fills[xf.fillId], themeColors),
    fontSize: font?.size !== undefined && font.size !== styles.fonts[0]?.size ? font.size : undefined,
  };
  return Object.values(style).some((value) => value !== undefined) ? style : undefined;
}

function resolvedFormat(
  xf: CellXf | undefined,
  styles: RawStyles,
  themeColors: readonly string[],
): CellFormat {
  if (!xf) return {};
  return {
    align: xf.horizontal === undefined ? undefined : ALIGNMENTS[xf.horizontal],
    wrap: xf.wrapText ? 'wrap' : xf.shrinkToFit || xf.horizontal === 'fill' ? 'clip' : undefined,
    style: cellStyleOf(xf, styles, themeColors),
  };
}

/**
 * Reads `styles.xml`: number formats, fonts, solid fills and cell formats, with colours resolved against
 * the theme. The default font's colour is dropped, so text keeps the viewer's own colour in a dark theme.
 * A workbook without styles gets the general format everywhere.
 *
 * @example
 * ```ts
 * const styles = readStyles(archive, 'xl/styles.xml', themeColors, work, DEFAULT_CAPS);
 * ```
 */
export function readStyles(
  archive: ZipArchive,
  path: string,
  themeColors: readonly string[],
  work: ReadWork,
  caps: ReaderCaps,
): WorkbookStyles {
  const styles: RawStyles = { numFmts: new Map(), fonts: [], fills: [], cellXfs: [] };
  readXmlPart(archive, path, styleCollector(styles), work, caps, true);
  const formats = new Map<number, CellFormat>();
  return {
    numberFormatOf: (styleIndex) => {
      const id = styles.cellXfs[styleIndex]?.numFmtId ?? 0;
      return styles.numFmts.get(id) ?? id;
    },
    formatOf: (styleIndex) => {
      let format = formats.get(styleIndex);
      if (!format) {
        format = resolvedFormat(styles.cellXfs[styleIndex], styles, themeColors);
        formats.set(styleIndex, format);
      }
      return format;
    },
  };
}
