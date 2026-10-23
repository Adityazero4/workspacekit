import { format, getFormatFromId, isDateFormat } from 'numfmt';

const DAYS_BETWEEN_1900_AND_1904_EPOCHS = 1462;
const LONGEST_FORMAT_CODE = 255;
const GENERAL = 'General';
const MOST_REMEMBERED_CODES = 4096;

const usableCodes = new Map<string, { code: string; isDate: boolean }>();

const GENERAL_FORMAT = Object.freeze({ code: GENERAL, isDate: false });

function usableCode(code: string): { code: string; isDate: boolean } {
  if (code.length > LONGEST_FORMAT_CODE) return GENERAL_FORMAT;
  let usable = usableCodes.get(code);
  if (!usable) {
    try {
      format(code, 0);
      usable = { code, isDate: isDateFormat(code) };
    } catch {
      usable = GENERAL_FORMAT;
    }
    if (usableCodes.size >= MOST_REMEMBERED_CODES) usableCodes.clear();
    usableCodes.set(code, usable);
  }
  return usable;
}

/**
 * How many format codes `formatNumber` currently remembers (at most 4,096, none over 255 characters).
 *
 * @example
 * ```ts
 * rememberedFormatCodeCount(); // 12
 * ```
 */
export const rememberedFormatCodeCount = (): number => usableCodes.size;

/**
 * The display text of a number under an Excel number format, given as a format code or a built-in format
 * id (as `styles.xml` refers to them). Dates in a workbook on the 1904 date system are shifted onto the
 * 1900 system first. A code longer than Excel's 255 characters, or one numfmt cannot read, falls back to
 * General; that verdict is remembered per code, so a pathological code is parsed once, not once per cell.
 *
 * @example
 * ```ts
 * formatNumber(1234.5, '#,##0.00', false); // '1,234.50'
 * formatNumber(45000, 14, false); // '3/15/2023'
 * ```
 */
export function formatNumber(value: number, formatCodeOrId: string | number, isDate1904: boolean): string {
  const requested =
    typeof formatCodeOrId === 'number' ? getFormatFromId(formatCodeOrId) || GENERAL : formatCodeOrId;
  const { code, isDate } = usableCode(requested);
  try {
    return format(code, isDate1904 && isDate ? value + DAYS_BETWEEN_1900_AND_1904_EPOCHS : value);
  } catch {
    return String(value);
  }
}
