import { expect, test } from 'vitest';
import { readDelimited } from '../src/reader/csv';
import { openBook } from '../src/reader/engine';
import { formatNumber, rememberedFormatCodeCount } from '../src/reader/numberFormat';
import { DEFAULT_CAPS, newReadWork, type ReaderCaps, type SheetData } from '../src/reader/types';
import { formulaCell, numberCell, sheetData, xlsxBytes, type FixtureWorkbook } from './support/xlsxFixture';

const read = async (workbook: FixtureWorkbook, caps: ReaderCaps = DEFAULT_CAPS) => {
  const work = newReadWork();
  const book = openBook(xlsxBytes(workbook), 'xlsx', caps, work);
  return { sheet: await book.sheet(0), book, work };
};

const columnLetters = (index: number): string => {
  let letters = '';
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    letters = String.fromCharCode(65 + ((remaining - 1) % 26)) + letters;
  }
  return letters;
};

const textAt = (sheet: SheetData, row: number, col: number): string | undefined => {
  for (let index = 0; index < sheet.cellTexts.length; index++) {
    if (sheet.cellRows[index] === row && sheet.cellCols[index] === col) return sheet.cellTexts[index];
  }
  return undefined;
};

test('a formula building millions of characters is charged in full, so only a few such cells are ever built', async () => {
  const concat = `CONCAT(${Array.from({ length: 500 }, () => 'REPT("x",32767)').join(',')})`;
  const rows = Array.from({ length: 30 }, (_, row) => [formulaCell(`A${row + 1}`, concat)]);
  const { sheet, work } = await read({ sheets: [{ name: 'S', body: sheetData(rows) }] });
  const filled = sheet.cellTexts.filter((text) => text !== '');
  expect(filled.length).toBeLessThanOrEqual(5);
  expect(filled.every((text) => text.length === DEFAULT_CAPS.maxCellText)).toBe(true);
  expect(work.formulaText).toBeLessThan(DEFAULT_CAPS.maxSheetText + 20_000_000);
  expect(sheet.isTruncated).toBe(true);
});

test('once the formula budget is spent, ranges are not built at all', async () => {
  const caps: ReaderCaps = { ...DEFAULT_CAPS, maxFormulaWork: 1_000 };
  const values = Array.from({ length: 20 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => numberCell(`${columnLetters(col)}${row + 1}`, 1)),
  );
  const sums = Array.from({ length: 200 }, (_, index) =>
    formulaCell(`${columnLetters(10 + (index % 40))}${1 + Math.floor(index / 40)}`, 'SUM(A:J)'),
  );
  values[0]!.push(...sums.slice(0, 40));
  for (let row = 1; row < 5; row++) values[row]!.push(...sums.slice(row * 40, row * 40 + 40));
  const { sheet, work } = await read({ sheets: [{ name: 'S', body: sheetData(values) }] }, caps);
  expect(work.formulaRangeCells).toBeLessThanOrEqual(caps.maxFormulaWork + 20 * 50);
  expect(sheet.isTruncated).toBe(true);
});

test.each([['IF(ISERROR(X),-1000,X+1)'], ['IFERROR(X+1,-1000)'], ['IFERROR(SUM(X:X)+1,-1000)']])(
  'a 100-deep chain of %s still evaluates deep end first',
  async (pattern) => {
    const cells = Array.from({ length: 100 }, (_, index) =>
      formulaCell(`${columnLetters(index)}1`, pattern.replaceAll('X', `${columnLetters(index + 1)}1`)),
    );
    cells.push(numberCell(`${columnLetters(100)}1`, 1));
    const { sheet } = await read({ sheets: [{ name: 'S', body: sheetData([cells]) }] });
    expect(textAt(sheet, 0, 0)).toBe('101');
  },
);

test('CSV with carriage-return line endings keeps every row', () => {
  const lines = Array.from({ length: 1_000 }, (_, row) => `${row},b${row},c${row}`);
  for (const lineEnd of ['\r', '\r\n', '\n']) {
    const sheet = readDelimited(new TextEncoder().encode(lines.join(lineEnd)), 'csv', DEFAULT_CAPS);
    expect([sheet.rowCount, sheet.colCount, sheet.isTruncated]).toEqual([1_000, 3, false]);
    expect(sheet.cellTexts.at(-1)).toBe('c999');
  }
});

test('at most 1,024 sheets are listed, and names are cut at 31 characters', () => {
  const sheets = `<sheet name="${'n'.repeat(100)}" sheetId="1" r:id="rId1"/>${'<sheet name="x" sheetId="2" r:id="rId1"/>'.repeat(2_000)}`;
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
  const bytes = xlsxBytes({ sheets: [{ name: 'S', body: '' }], parts: { 'xl/workbook.xml': workbook } });
  const book = openBook(bytes, 'xlsx', DEFAULT_CAPS, newReadWork());
  expect(book.info.sheets).toHaveLength(1_024);
  expect(book.info.hasMoreSheets).toBe(true);
  expect(book.info.sheets[0]!.name).toHaveLength(31);
});

test('format codes over 255 characters are never remembered', () => {
  const before = rememberedFormatCodeCount();
  for (let index = 0; index < 50; index++) formatNumber(1, `${'0'.repeat(300)}${index}`, false);
  expect(rememberedFormatCodeCount()).toBe(before);
});

const HUGE = 'n'.repeat(5_000_000);
const huge = (part: string, body: string): FixtureWorkbook => ({
  sheets: [{ name: 'S', body: sheetData([[numberCell('A1', 1)]]) }],
  parts: { [part]: body },
});

test.each([
  [
    'a cell value',
    huge(
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>${HUGE}</v></c></row></sheetData></worksheet>`,
    ),
  ],
  [
    'an attribute',
    huge(
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData><row r="1"><c r="A1" x="${HUGE}"><v>1</v></c></row></sheetData></worksheet>`,
    ),
  ],
  ['a comment', huge('xl/worksheets/sheet1.xml', `<worksheet><!--${HUGE}--><sheetData/></worksheet>`)],
  [
    'a sheet name',
    huge(
      'xl/workbook.xml',
      `<workbook xmlns:r="r"><sheets><sheet name="${HUGE}" r:id="rId1"/></sheets></workbook>`,
    ),
  ],
])('one XML node of 5 million characters in %s is too_large before it is handed on', async (_, workbook) => {
  await expect(read(workbook)).rejects.toMatchObject({ kind: 'too_large' });
});

test('MAX and MIN evaluate, ignoring text and blanks and passing errors on', async () => {
  const body = sheetData([
    [
      numberCell('A1', 4),
      numberCell('B1', -2),
      '<c r="C1" t="inlineStr"><is><t>x</t></is></c>',
      numberCell('D1', 9),
    ],
    [
      formulaCell('A2', 'MAX(A1:D1)'),
      formulaCell('B2', 'MIN(A1:D1,1)'),
      formulaCell('C2', 'MAX(A1,1/0)'),
      formulaCell('D2', 'MIN(E1:E5)'),
    ],
  ]);
  const { sheet } = await read({ sheets: [{ name: 'S', body }] });
  expect([textAt(sheet, 1, 0), textAt(sheet, 1, 1), textAt(sheet, 1, 2), textAt(sheet, 1, 3)]).toEqual([
    '9',
    '-2',
    '#DIV/0!',
    '0',
  ]);
});

test('a cycle leaves its cells empty without marking the sheet truncated, however long it is', async () => {
  for (const length of [3, 100]) {
    const cells = Array.from({ length }, (_, index) =>
      formulaCell(`${columnLetters(index)}1`, `${columnLetters((index + 1) % length)}1+1`),
    );
    const { sheet } = await read({ sheets: [{ name: 'S', body: sheetData([cells]) }] });
    expect(sheet.cellTexts.every((text) => text === '')).toBe(true);
    expect(sheet.isTruncated).toBe(false);
  }
});
