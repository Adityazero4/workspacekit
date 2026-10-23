import { textBudget, type ReadWork, type ReaderCaps } from '../types';
import { readXmlPart } from './xml';
import type { ZipArchive } from './zip';

/**
 * Reads the workbook's shared string table. Its declared `count` is ignored, so a table claiming billions
 * of strings allocates nothing up front; reading stops after `caps.maxSharedStrings` strings, and cells
 * pointing past them show empty. Rich text runs are joined, and phonetic guides (`rPh`) are left out. Each
 * string keeps at most `caps.maxCellText` characters, and the table stops at `caps.maxSheetText`
 * characters in all.
 *
 * @example
 * ```ts
 * const strings = readSharedStrings(archive, 'xl/sharedStrings.xml', caps, work);
 * ```
 */
export function readSharedStrings(
  archive: ZipArchive,
  path: string,
  caps: ReaderCaps,
  work: ReadWork,
): string[] {
  const strings: string[] = [];
  const budget = textBudget(caps);
  let current: string[] | undefined;
  let currentLength = 0;
  let textDepth = 0;
  let phoneticDepth = 0;
  readXmlPart(
    archive,
    path,
    {
      open: (name) => {
        if (name === 'si') {
          current = [];
          currentLength = 0;
        } else if (name === 'rPh') phoneticDepth++;
        else if (name === 't' && phoneticDepth === 0) textDepth++;
      },
      close: (name) => {
        if (name === 'si' && current) {
          strings.push(budget.take(current.join('')));
          current = undefined;
        } else if (name === 'rPh') phoneticDepth--;
        else if (name === 't' && textDepth > 0) textDepth--;
      },
      text: (text) => {
        if (!current || textDepth === 0 || currentLength >= caps.maxCellText) return;
        current.push(text);
        currentLength += text.length;
      },
      isDone: () => strings.length >= caps.maxSharedStrings || budget.isSpent,
    },
    work,
    caps,
    true,
  );
  return strings;
}
