import { expect, test } from 'vitest';
import { findCells } from '../src/reader/search';
import { openWithSheetJs, type SheetJsModule } from '../src/reader/sheetjs';
import { sheetGridModel } from '../src/reader/gridModel';
import { createReaderSession } from '../src/reader/session';
import { DEFAULT_CAPS, type SheetData } from '../src/reader/types';
import { numberCell, sheetData, xlsxBytes } from './support/xlsxFixture';

test('xls without an injected SheetJS fails with the install message', async () => {
  await expect(openWithSheetJs(undefined, new Uint8Array(8), 'xls', DEFAULT_CAPS)).rejects.toMatchObject({
    kind: 'unsupported_media',
    message: expect.stringContaining("engines: { xlsx: () => import('xlsx') }"),
  });
});

const fakeSheetJs: SheetJsModule = {
  read: () => ({
    SheetNames: ['Legacy'],
    Sheets: {
      Legacy: {
        '!ref': 'A1:B3',
        A1: { t: 's', v: 'name', w: 'name' },
        B2: { t: 'n', v: 0.5, w: '50%' },
        '!merges': [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
        '!rows': [undefined, { hidden: true }],
      },
    },
  }),
  utils: {
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 2, c: 1 } }),
    encode_cell: ({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`,
  },
};

test('SheetJS: a listed sheet without data (a chart sheet) or an index out of range is a ReaderError', async () => {
  const chartSheet: SheetJsModule = {
    ...fakeSheetJs,
    read: () => ({ SheetNames: ['Chart1'], Sheets: {} }),
  };
  const book = await openWithSheetJs(async () => chartSheet, new Uint8Array(8), 'xls', DEFAULT_CAPS);
  await expect(book.sheet(0)).rejects.toMatchObject({ name: 'ReaderError', kind: 'load_error' });
  await expect(book.sheet(5)).rejects.toMatchObject({ name: 'ReaderError', kind: 'load_error' });
});

test('SheetJS: at most 1,024 sheets are listed, with names cut at 31 characters', async () => {
  const names = ['n'.repeat(100), ...Array.from({ length: 2_000 }, (_, index) => `S${index}`)];
  const many: SheetJsModule = {
    ...fakeSheetJs,
    read: () => ({
      SheetNames: names,
      Sheets: { [names[0]!]: { '!ref': 'A1:A1', A1: { t: 's', v: 'x', w: 'x' } } },
    }),
  };
  const book = await openWithSheetJs(async () => many, new Uint8Array(8), 'xls', DEFAULT_CAPS);
  expect(book.info.sheets).toHaveLength(1_024);
  expect(book.info.hasMoreSheets).toBe(true);
  expect(book.info.sheets[0]!.name).toHaveLength(31);
  expect((await book.sheet(0)).cellTexts).toEqual(['x']);
});

test('an injected SheetJS reads xls into the same sheet shape, with its display text', async () => {
  const book = await openWithSheetJs(
    async () => ({ default: fakeSheetJs }),
    new Uint8Array(8),
    'xls',
    DEFAULT_CAPS,
  );
  expect(book.info.sheets).toEqual([{ name: 'Legacy', isHidden: false }]);
  const sheet = await book.sheet(0);
  expect(sheet.cellTexts).toEqual(['name', '50%']);
  expect(sheet.cellKinds).toEqual(['text', 'number']);
  expect(sheet.merges).toEqual([{ top: 0, left: 0, bottom: 0, right: 1 }]);
  expect([...sheet.hiddenRows]).toEqual([0, 1, 0]);
});

test('the worker session opens, reads a sheet and searches it, case-insensitively', async () => {
  const handle = createReaderSession();
  const bytes = xlsxBytes({
    sheets: [
      {
        name: 'S',
        body: sheetData([[numberCell('A1', 1)], ['<c r="B2" t="inlineStr"><is><t>Grand Total</t></is></c>']]),
      },
    ],
  });
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  expect(await handle({ id: 1, type: 'open', data, format: 'xlsx', caps: DEFAULT_CAPS })).toMatchObject({
    ok: true,
    result: { sheets: [{ name: 'S' }] },
  });
  expect(await handle({ id: 2, type: 'search', index: 0, query: 'total' })).toEqual({
    id: 2,
    ok: true,
    result: [{ row: 1, col: 1 }],
  });
  expect(await handle({ id: 3, type: 'sheet', index: 7 })).toMatchObject({
    id: 3,
    ok: false,
    error: { kind: 'load_error' },
  });
});

const sheetWith = (overrides: Partial<SheetData>): SheetData => ({
  name: 'S',
  rowCount: 4,
  colCount: 3,
  cellRows: Uint32Array.from([0, 2, 3]),
  cellCols: Uint32Array.from([0, 2, 1]),
  cellTexts: ['a', 'c', '7'],
  cellKinds: ['text', 'text', 'number'],
  cellFormats: new Uint32Array(3),
  formats: [{}],
  merges: [{ top: 1, left: 0, bottom: 3, right: 1 }],
  rowHeights: Float64Array.from([20, 20, 30, 20]),
  colWidths: Float64Array.from([64, 80, 64]),
  hiddenRows: Uint8Array.from([0, 1, 0, 0]),
  hiddenCols: Uint8Array.from([0, 0, 0]),
  frozen: { rows: 2, cols: 0 },
  isTruncated: false,
  hasTooManyMerges: false,
  ...overrides,
});

test('the grid model leaves hidden rows out, keeps their numbers, pads, and anchors merges on visible rows', () => {
  const model = sheetGridModel(sheetWith({}));
  expect([model.rowCount, model.colCount]).toEqual([49, 26]);
  expect([model.rowLabel!(0), model.rowLabel!(1), model.rowLabel!(2)]).toEqual(['1', '3', '4']);
  expect(model.cell(1, 2)?.text).toBe('c');
  expect(model.cell(2, 1)).toMatchObject({ text: '7', isNumber: true, align: 'right' });
  expect(model.rowHeight(1)).toBe(30);
  expect(model.merges).toEqual([{ top: 1, left: 0, bottom: 2, right: 1 }]);
  expect(model.frozen).toEqual({ rows: 1, cols: 0 });
  expect(model.colLabel!(2)).toBe('C');
});

test('an empty sheet has no rows, and search finds nothing for an empty query', () => {
  const empty = sheetWith({
    rowCount: 0,
    colCount: 0,
    cellRows: new Uint32Array(),
    cellCols: new Uint32Array(),
    cellTexts: [],
    cellKinds: [],
    merges: [],
  });
  expect(sheetGridModel(empty).rowCount).toBe(0);
  expect(findCells(sheetWith({}), '')).toEqual([]);
});
