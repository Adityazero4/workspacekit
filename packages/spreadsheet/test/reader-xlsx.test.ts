import { beforeEach, expect, test, vi } from 'vitest';
import { openBook } from '../src/reader/engine';
import { DEFAULT_CAPS, newReadWork, type SheetData } from '../src/reader/types';
import {
  formulaCell,
  inlineCell,
  numberCell,
  sheetData,
  xlsxBytes,
  type FixtureWorkbook,
} from './support/xlsxFixture';

const formulaEngine = vi.hoisted(() => ({ loads: 0 }));
vi.mock('fast-formula-parser', async (importOriginal) => {
  formulaEngine.loads++;
  return importOriginal();
});
beforeEach(() => {
  formulaEngine.loads = 0;
});

const readSheet = (workbook: FixtureWorkbook, index = 0): Promise<SheetData> =>
  openBook(xlsxBytes(workbook), 'xlsx', DEFAULT_CAPS, newReadWork()).sheet(index);

const textAt = (sheet: SheetData, row: number, col: number): string | undefined => {
  for (let index = 0; index < sheet.cellTexts.length; index++) {
    if (sheet.cellRows[index] === row && sheet.cellCols[index] === col) return sheet.cellTexts[index];
  }
  return undefined;
};

const STYLES = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><color theme="1"/></font><font><b/><sz val="11"/><color rgb="FFFF0000"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="164" fontId="0" fillId="0"/><xf numFmtId="14" fontId="1" fillId="2"/><xf numFmtId="0" fontId="0" fillId="0"><alignment horizontal="center" wrapText="1"/></xf></cellXfs>
</styleSheet>`;
const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>
</a:clrScheme></a:themeElements></a:theme>`;

test('reads merges, column widths, row heights, hidden rows and columns, and frozen panes', async () => {
  const body = [
    '<sheetViews><sheetView><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews>',
    '<cols><col min="2" max="2" width="20" customWidth="1"/><col min="3" max="3" width="9" hidden="1"/><col min="1" max="16384" width="5"/></cols>',
    '<sheetData><row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>',
    '<row r="2" hidden="1"><c r="A2"><v>2</v></c></row><row r="3"><c r="B3"><v>3</v></c></row></sheetData>',
    '<mergeCells count="1"><mergeCell ref="B1:C2"/></mergeCells>',
  ].join('');
  const sheet = await readSheet({ sheets: [{ name: 'Layout', body }] });
  expect(sheet.merges).toEqual([{ top: 0, left: 1, bottom: 1, right: 2 }]);
  expect([...sheet.colWidths]).toEqual([64, 140, 64, 64]);
  expect(sheet.rowHeights[0]).toBe(40);
  expect(sheet.rowHeights[1]).toBe(20);
  expect([...sheet.hiddenRows]).toEqual([0, 1, 0]);
  expect([...sheet.hiddenCols]).toEqual([0, 0, 1, 0]);
  expect(sheet.frozen).toEqual({ rows: 2, cols: 1 });
  expect([sheet.rowCount, sheet.colCount]).toEqual([3, 4]);
});

test('display text comes from numfmt with built-in and custom formats; styles and theme colours resolve', async () => {
  const body = sheetData([
    [
      numberCell('A1', 1234.5, 1),
      numberCell('B1', 45000, 2),
      '<c r="C1" s="3" t="b"><v>1</v></c>',
      '<c r="D1" t="e"><v>#N/A</v></c>',
    ],
  ]);
  const sheet = await readSheet({ sheets: [{ name: 'S', body }], styles: STYLES, theme: THEME });
  expect(sheet.cellTexts).toEqual(['1,234.50', '3/15/2023', 'TRUE', '#N/A']);
  expect(sheet.cellKinds).toEqual(['number', 'number', 'boolean', 'error']);
  const dateFormat = sheet.formats[sheet.cellFormats[1]!]!;
  expect(dateFormat.style).toEqual({ bold: true, color: '#ff0000', fill: '#a2b8e2' });
  expect(sheet.formats[sheet.cellFormats[2]!]).toMatchObject({ align: 'center', wrap: 'wrap' });
  expect(sheet.formats[sheet.cellFormats[0]!]!.style).toBeUndefined();
});

test('a 1904 workbook shifts dates; shared and inline strings read, phonetic guides left out', async () => {
  const strings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Hel</t></r><r><t>lo</t></r><rPh><t>ignored</t></rPh></si></sst>`;
  const body = sheetData([
    [numberCell('A1', 45000 - 1462, 2), '<c r="B1" t="s"><v>0</v></c>', inlineCell('C1', 'inline & text')],
  ]);
  const sheet = await readSheet({
    sheets: [{ name: 'S', body }],
    styles: STYLES,
    sharedStrings: strings,
    date1904: true,
  });
  expect(sheet.cellTexts).toEqual(['3/15/2023', 'Hello', 'inline & text']);
});

test('cached formula values are shown without loading the formula engine', async () => {
  const sheet = await readSheet({
    sheets: [{ name: 'S', body: sheetData([[numberCell('A1', 2), formulaCell('B1', 'A1*21', 42)]]) }],
  });
  expect(textAt(sheet, 0, 1)).toBe('42');
  expect(formulaEngine.loads).toBe(0);
});

test('uncached formulas are evaluated with the lazily loaded engine, and errors keep their text', async () => {
  const body = sheetData([
    [numberCell('A1', 2), numberCell('B1', 3), formulaCell('C1', 'SUM(A1:B1)*2')],
    [formulaCell('A2', '1/0'), formulaCell('B2', 'SUM(B1:C1)'), formulaCell('C2', 'IFERROR(1/0,"none")')],
  ]);
  const sheet = await readSheet({ sheets: [{ name: 'S', body }] });
  expect(formulaEngine.loads).toBe(1);
  expect([textAt(sheet, 0, 2), textAt(sheet, 1, 0), textAt(sheet, 1, 2)]).toEqual(['10', '#DIV/0!', 'none']);
  expect(textAt(sheet, 1, 1)).toBe('13');
});

test('a range over a whole column visits only the rows that exist', async () => {
  const work = newReadWork();
  const body = sheetData([[numberCell('A1', 1), formulaCell('B1', 'SUM(A:A)')], [numberCell('A2', 2)]]);
  const sheet = await openBook(
    xlsxBytes({ sheets: [{ name: 'S', body }] }),
    'xlsx',
    DEFAULT_CAPS,
    work,
  ).sheet(0);
  expect(textAt(sheet, 0, 1)).toBe('3');
  expect(work.formulaCells).toBeLessThanOrEqual(2);
});

test('a cycle leaves every cell in it empty, and cells outside it still evaluate', async () => {
  const body = sheetData([[formulaCell('A1', 'B1+1'), formulaCell('B1', 'A1+1'), formulaCell('C1', '5*2')]]);
  const sheet = await readSheet({ sheets: [{ name: 'S', body }] });
  expect([textAt(sheet, 0, 0), textAt(sheet, 0, 1), textAt(sheet, 0, 2)]).toEqual(['', '', '10']);
});

test('cross-sheet references read the other sheet, including its own uncached formulas', async () => {
  const sheets = [
    { name: 'Summary', body: sheetData([[formulaCell('A1', "Data!B1+'Other sheet'!A1")]]) },
    { name: 'Data', body: sheetData([[numberCell('A1', 4), formulaCell('B1', 'A1*10')]]) },
    { name: 'Other sheet', body: sheetData([[numberCell('A1', 2)]]) },
  ];
  const sheet = await readSheet({ sheets });
  expect(textAt(sheet, 0, 0)).toBe('42');
});

test('shared formulas move their relative references to each cell', async () => {
  const body = sheetData([
    [numberCell('A1', 1), '<c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f></c>'],
    [numberCell('A2', 2), '<c r="B2"><f t="shared" si="0"/></c>'],
    [numberCell('A3', 3), '<c r="B3"><f t="shared" si="0"/></c>'],
  ]);
  const sheet = await readSheet({ sheets: [{ name: 'S', body }] });
  expect([textAt(sheet, 0, 1), textAt(sheet, 1, 1), textAt(sheet, 2, 1)]).toEqual(['2', '4', '6']);
});

test('sheet names, hidden sheets and an empty sheet', async () => {
  const book = openBook(
    xlsxBytes({
      sheets: [
        { name: 'One', body: '' },
        { name: 'Two', body: '<sheetData/>', state: 'hidden' },
      ],
    }),
    'xlsx',
    DEFAULT_CAPS,
    newReadWork(),
  );
  expect(book.info.sheets).toEqual([
    { name: 'One', isHidden: false },
    { name: 'Two', isHidden: true },
  ]);
  const empty = await book.sheet(1);
  expect([empty.rowCount, empty.colCount, empty.cellTexts.length]).toEqual([0, 0, 0]);
});

test('the extent comes from cells with a value, formula or style, not the declared dimension', async () => {
  const body = `<dimension ref="A1:Z9999"/>${sheetData([[numberCell('A1', 1), '<c r="C1" s="1"/>', '<c r="F1"/>']])}`;
  const sheet = await readSheet({ sheets: [{ name: 'S', body }], styles: STYLES });
  expect([sheet.rowCount, sheet.colCount]).toEqual([1, 3]);
});

test('a pane freezing 20,000 rows is clamped to 20, and merges past 10,000 are dropped and flagged', async () => {
  const merges = Array.from(
    { length: 10_001 },
    (_, index) => `<mergeCell ref="A${index * 2 + 1}:B${index * 2 + 2}"/>`,
  ).join('');
  const body = [
    '<sheetViews><sheetView><pane xSplit="900" ySplit="20000" state="frozen"/></sheetView></sheetViews>',
    sheetData(
      Array.from({ length: 30 }, (_, row) => [
        numberCell(`A${row + 1}`, row),
        numberCell(`L${row + 1}`, row),
      ]),
    ),
    `<mergeCells>${merges}</mergeCells>`,
  ].join('');
  const sheet = await readSheet({ sheets: [{ name: 'S', body }] });
  expect(sheet.frozen).toEqual({ rows: 20, cols: 10 });
  expect(sheet.hasTooManyMerges).toBe(true);
  expect(sheet.merges.length).toBeLessThanOrEqual(10_000);
});
