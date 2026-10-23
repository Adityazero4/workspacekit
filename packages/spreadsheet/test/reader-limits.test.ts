import { beforeEach, expect, test, vi } from 'vitest';
import { openBook } from '../src/reader/engine';
import { DEFAULT_CAPS, newReadWork, ReaderError, type ReaderCaps, type SheetData } from '../src/reader/types';
import { formulaCell, numberCell, sheetData, xlsxBytes, type FixtureWorkbook } from './support/xlsxFixture';

const numfmtCalls = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock('numfmt', async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & { format: (...args: unknown[]) => string }
  >();
  return {
    ...original,
    format: (code: string, ...rest: unknown[]) => {
      numfmtCalls.codes.push(code);
      return original.format(code, ...rest);
    },
  };
});
beforeEach(() => {
  numfmtCalls.codes = [];
});

const read = async (workbook: FixtureWorkbook, caps: ReaderCaps = DEFAULT_CAPS, index = 0) => {
  const work = newReadWork();
  const book = openBook(xlsxBytes(workbook), 'xlsx', caps, work);
  return { sheet: await book.sheet(index), book, work };
};

const textAt = (sheet: SheetData, row: number, col: number): string | undefined => {
  for (let index = 0; index < sheet.cellTexts.length; index++) {
    if (sheet.cellRows[index] === row && sheet.cellCols[index] === col) return sheet.cellTexts[index];
  }
  return undefined;
};

const columnLetters = (index: number): string => {
  let letters = '';
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    letters = String.fromCharCode(65 + ((remaining - 1) % 26)) + letters;
  }
  return letters;
};

const totalText = (sheet: SheetData): number => sheet.cellTexts.reduce((sum, text) => sum + text.length, 0);

test('one huge shared string fanned out to many cells is cut per cell and stops at the sheet text budget', async () => {
  const caps: ReaderCaps = { ...DEFAULT_CAPS, maxSheetText: 1024 * 1024 };
  const strings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${'y'.repeat(65_536)}</t></si></sst>`;
  const rows = Array.from({ length: 50 }, (_, row) =>
    Array.from({ length: 40 }, (_, col) => `<c r="${columnLetters(col)}${row + 1}" t="s"><v>0</v></c>`),
  );
  const { sheet } = await read(
    { sheets: [{ name: 'S', body: sheetData(rows) }], sharedStrings: strings },
    caps,
  );
  expect(Math.max(...sheet.cellTexts.map((text) => text.length))).toBe(DEFAULT_CAPS.maxCellText);
  expect(totalText(sheet)).toBeLessThanOrEqual(caps.maxSheetText);
  expect(sheet.isTruncated).toBe(true);
});

test('inline strings and number-format output are cut at 32,767 characters', async () => {
  const body = sheetData([[`<c r="A1" t="inlineStr"><is><t>${'z'.repeat(40_000)}</t></is></c>`]]);
  const { sheet } = await read({ sheets: [{ name: 'S', body }] });
  expect(sheet.cellTexts[0]!.length).toBe(32_767);
});

test('REPT past 32,767 characters is #VALUE!, and formula text results are cut', async () => {
  const body = sheetData([
    [formulaCell('A1', 'REPT("x",40000)'), formulaCell('B1', 'REPT("ab",3)')],
    [`<c r="A2" t="inlineStr"><is><t>${'q'.repeat(30_000)}</t></is></c>`, formulaCell('B2', 'A2&A2')],
  ]);
  const { sheet, work } = await read({ sheets: [{ name: 'S', body }] });
  expect([textAt(sheet, 0, 0), textAt(sheet, 0, 1)]).toEqual(['#VALUE!', 'ababab']);
  expect(textAt(sheet, 1, 1)!.length).toBe(32_767);
  expect(work.formulaText).toBeLessThan(200_000);
});

test('XML nested deeper than the cap is too_large; so is a workbook with too many elements', async () => {
  const nested = `<?xml version="1.0"?><worksheet>${'<a>'.repeat(300)}${'</a>'.repeat(300)}<sheetData/></worksheet>`;
  const deep: FixtureWorkbook = {
    sheets: [{ name: 'S', body: '' }],
    parts: { 'xl/worksheets/sheet1.xml': nested },
  };
  await expect(read(deep)).rejects.toMatchObject({ kind: 'too_large' });
  const rows = Array.from({ length: 100 }, (_, row) => [numberCell(`A${row + 1}`, row)]);
  const many: FixtureWorkbook = { sheets: [{ name: 'S', body: sheetData(rows) }] };
  await expect(read(many, { ...DEFAULT_CAPS, maxXmlElements: 150 })).rejects.toBeInstanceOf(ReaderError);
});

test('a number format code over 255 characters is never handed to numfmt; a broken one is parsed once', async () => {
  const longCode = '['.repeat(300) + '0';
  const brokenCode = '0;0;0;0;0';
  const styles = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="${longCode}"/><numFmt numFmtId="165" formatCode="${brokenCode}"/></numFmts><cellXfs count="3"><xf/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
  const rows = Array.from({ length: 200 }, (_, row) => [
    numberCell(`A${row + 1}`, row, 1),
    numberCell(`B${row + 1}`, row, 2),
  ]);
  const { sheet } = await read({ sheets: [{ name: 'S', body: sheetData(rows) }], styles });
  expect(textAt(sheet, 5, 0)).toBe('5');
  expect(numfmtCalls.codes.filter((code) => code === longCode)).toHaveLength(0);
  expect(numfmtCalls.codes.filter((code) => code === brokenCode).length).toBeLessThanOrEqual(1);
});

test('only the first 1,024 <col> records are read', async () => {
  const records = Array.from(
    { length: 1_025 },
    (_, index) => `<col min="1" max="1" width="${index === 1_024 ? 50 : 10}" customWidth="1"/>`,
  ).join('');
  const { sheet } = await read({
    sheets: [{ name: 'S', body: `<cols>${records}</cols>${sheetData([[numberCell('A1', 1)]])}` }],
  });
  expect(sheet.colWidths[0]).toBe(70);
});

test('formula work is checked per cell visited: past the budget cells are left empty, never a wrong value', async () => {
  const caps: ReaderCaps = { ...DEFAULT_CAPS, maxFormulaWork: 1_000 };
  const values = Array.from({ length: 100 }, (_, row) => [numberCell(`A${row + 1}`, 1)]);
  const sums = Array.from({ length: 30 }, (_, index) =>
    formulaCell(`${columnLetters(index + 1)}1`, 'SUM(A1:A100)'),
  );
  values[0]!.push(...sums);
  const { sheet, work } = await read({ sheets: [{ name: 'S', body: sheetData(values) }] }, caps);
  expect(work.formulaCells).toBeLessThanOrEqual(caps.maxFormulaWork);
  const results = sums.map((_, index) => textAt(sheet, 0, index + 1));
  expect(results.every((text) => text === '100' || text === '')).toBe(true);
  expect(results).toContain('');
});

test('a 70-formula chain evaluates to the right value, deep end first', async () => {
  const cells = Array.from({ length: 70 }, (_, index) =>
    formulaCell(`${columnLetters(index)}1`, `${columnLetters(index + 1)}1+1`),
  );
  cells.push(numberCell(`${columnLetters(70)}1`, 1));
  const { sheet } = await read({ sheets: [{ name: 'S', body: sheetData([cells]) }] });
  expect(textAt(sheet, 0, 0)).toBe('71');
});

test('a formula the engine fails on shows #ERROR! without failing the sheet', async () => {
  const deep = `${'('.repeat(4_000)}1${')'.repeat(4_000)}`;
  const { sheet } = await read({
    sheets: [{ name: 'S', body: sheetData([[formulaCell('A1', deep), formulaCell('B1', '2*3')]]) }],
  });
  expect(textAt(sheet, 0, 1)).toBe('6');
  expect(['1', '#ERROR!']).toContain(textAt(sheet, 0, 0));
});

test('a reference to a missing sheet is #REF!', async () => {
  const { sheet } = await read({
    sheets: [
      {
        name: 'S',
        body: sheetData([[formulaCell('A1', 'Nowhere!A1+1'), formulaCell('B1', 'SUM(Nowhere!A1:A3)')]]),
      },
    ],
  });
  expect([textAt(sheet, 0, 0), textAt(sheet, 0, 1)]).toEqual(['#REF!', '#REF!']);
});

test("a sheet's data is made once: reading or searching it again costs no formula work", async () => {
  const { book, work, sheet } = await read({
    sheets: [{ name: 'S', body: sheetData([[numberCell('A1', 2), formulaCell('B1', 'A1*2')]]) }],
  });
  const workAfterFirstRead = work.formulaCells;
  expect(await book.sheet(0)).toBe(sheet);
  expect(work.formulaCells).toBe(workAfterFirstRead);
});

test('one cell past the column cap is dropped on its own; the rest of the sheet is still read', async () => {
  const rows = Array.from({ length: 10 }, (_, row) => [
    numberCell(`A${row + 1}`, row),
    ...(row === 0 ? ['<c r="XFD1" s="3"/>'] : []),
  ]);
  const { sheet } = await read({ sheets: [{ name: 'S', body: sheetData(rows) }] });
  expect(sheet.rowCount).toBe(10);
  expect(sheet.isTruncated).toBe(true);
});

test('row heights, column widths and font sizes are clamped; 0 hides, unusable values are ignored', async () => {
  const body = [
    '<sheetFormatPr defaultRowHeight="1e308" defaultColWidth="-40"/>',
    '<cols><col min="1" max="1" width="1e300"/><col min="2" max="2" width="abc"/><col min="3" max="3" width="0"/></cols>',
    '<sheetData><c r="A1"><v>7</v></c>',
    '<row r="1" ht="-500"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1" s="1"><v>3</v></c></row>',
    '<row r="2" ht="NaN"><c r="A2"><v>4</v></c></row><row r="3" ht="1e300"><c r="A3"><v>5</v></c></row>',
    '<row r="4" ht="0"><c r="A4"><v>6</v></c></row></sheetData>',
  ].join('');
  const styles = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/></font><font><sz val="1e9"/></font></fonts><cellXfs count="2"><xf/><xf fontId="1"/></cellXfs></styleSheet>`;
  const { sheet } = await read({ sheets: [{ name: 'S', body }], styles });
  expect([...sheet.rowHeights]).toEqual([545, 545, 545, 545]);
  expect([...sheet.colWidths]).toEqual([1785, 64, 64]);
  expect([...sheet.hiddenRows]).toEqual([0, 0, 0, 1]);
  expect([...sheet.hiddenCols]).toEqual([0, 0, 1]);
  expect(sheet.formats.every((format) => format.style?.fontSize === undefined)).toBe(true);
  expect(sheet.rowCount).toBe(4);
});

test('after the caps, merges under a namespace prefix are still found', async () => {
  const rows = Array.from({ length: 3_000 }, (_, row) => [
    numberCell(`A${row + 1}`, (row * 7_919) % 104_729),
    numberCell(`B${row + 1}`, (row * 104_723) % 7_907),
  ]);
  const body = `${sheetData(rows)}<x:mergeCells xmlns:x="urn:x"><x:mergeCell ref="A1:B2"/></x:mergeCells>`;
  const { sheet } = await read({ sheets: [{ name: 'S', body }] }, { ...DEFAULT_CAPS, maxRows: 10 });
  expect(sheet.merges).toEqual([{ top: 0, left: 0, bottom: 1, right: 1 }]);
});
