import { strToU8, zipSync } from 'fflate';
import { expect, test } from 'vitest';
import { openBook } from '../src/reader/engine';
import { DEFAULT_CAPS, newReadWork, ReaderError, type ReaderCaps } from '../src/reader/types';
import { openZip } from '../src/reader/xlsx/zip';
import { numberCell, sheetData, withDeclaredSize, xlsxBytes } from './support/xlsxFixture';

const MEBIBYTE = 1024 * 1024;

const rejection = (read: () => unknown): ReaderError => {
  try {
    read();
  } catch (error) {
    if (error instanceof ReaderError) return error;
    throw error;
  }
  throw new Error('expected the read to be refused');
};

const sheetOfRows = (rows: number, cols = 1): string =>
  sheetData(
    Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => numberCell(`${String.fromCharCode(65 + col)}${row + 1}`, row)),
    ),
  );

test('a zip bomb is refused from its central directory, before a single byte is inflated', () => {
  const bomb = withDeclaredSize(
    xlsxBytes({ sheets: [{ name: 'S', body: sheetOfRows(2) }] }),
    'xl/worksheets/sheet1.xml',
    4_000_000_000,
  );
  const work = newReadWork();
  const error = rejection(() => openBook(bomb, 'xlsx', DEFAULT_CAPS, work));
  expect(error.kind).toBe('too_large');
  expect(work.inflatedBytes).toBe(0);
});

test('an entry inflating past its declared size stops at the first chunk over it, whatever the header claims', () => {
  const zeros = new Uint8Array(20 * MEBIBYTE);
  const lying = withDeclaredSize(zipSync({ 'big.xml': zeros }), 'big.xml', 1_000);
  const work = newReadWork();
  const archive = openZip(lying, DEFAULT_CAPS, work);
  const error = rejection(() => archive.streamText('big.xml', () => true));
  expect(error.kind).toBe('too_large');
  expect(work.inflatedBytes).toBeLessThan(2 * MEBIBYTE);
});

test('the total inflated across entries is capped too', () => {
  const caps: ReaderCaps = { ...DEFAULT_CAPS, maxInflatedBytes: 2 * MEBIBYTE };
  const parts = { 'a.xml': new Uint8Array(1.5 * MEBIBYTE), 'b.xml': new Uint8Array(0.4 * MEBIBYTE) };
  const work = newReadWork();
  const archive = openZip(zipSync(parts), caps, work);
  archive.streamText('a.xml', () => true);
  archive.streamText('b.xml', () => true);
  const again = rejection(() => archive.streamText('a.xml', () => true));
  expect(again.kind).toBe('too_large');
  expect(work.inflatedBytes).toBeLessThanOrEqual(caps.maxInflatedBytes + 2 * MEBIBYTE);
});

test('a file over the compressed cap is refused without reading its directory', () => {
  const caps: ReaderCaps = { ...DEFAULT_CAPS, maxCompressedBytes: 10 };
  expect(
    rejection(() => openBook(xlsxBytes({ sheets: [{ name: 'S', body: '' }] }), 'xlsx', caps, newReadWork()))
      .kind,
  ).toBe('too_large');
});

test('a shared string table claiming billions of strings allocates nothing up front and stops at the cap', async () => {
  const items = Array.from({ length: 5_000 }, (_, index) => `<si><t>s${index}</t></si>`).join('');
  const table = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4294967295" uniqueCount="4294967295">${items}</sst>`;
  const bytes = xlsxBytes({
    sheets: [
      { name: 'S', body: sheetData([['<c r="A1" t="s"><v>10</v></c>', '<c r="B1" t="s"><v>4000</v></c>']]) },
    ],
    sharedStrings: table,
  });
  const work = newReadWork();
  const sheet = await openBook(bytes, 'xlsx', { ...DEFAULT_CAPS, maxSharedStrings: 100 }, work).sheet(0);
  expect(sheet.cellTexts).toEqual(['s10', '']);
  expect(work.xmlElements).toBeLessThan(400);
});

test('the row cap stops parsing cells early: the rest of the sheet is only scanned for merges', async () => {
  const body = `${sheetOfRows(5_000, 3)}<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>`;
  const work = newReadWork();
  const sheet = await openBook(
    xlsxBytes({ sheets: [{ name: 'S', body }] }),
    'xlsx',
    { ...DEFAULT_CAPS, maxRows: 100 },
    work,
  ).sheet(0);
  expect(sheet.rowCount).toBe(100);
  expect(sheet.isTruncated).toBe(true);
  expect(sheet.merges).toEqual([{ top: 0, left: 0, bottom: 1, right: 1 }]);
  expect(work.xmlElements).toBeLessThan(1_000);
});

test('the row cap shrinks so rows × columns fits the cell budget', async () => {
  const caps: ReaderCaps = { ...DEFAULT_CAPS, maxCells: 300 };
  const sheet = await openBook(
    xlsxBytes({ sheets: [{ name: 'S', body: sheetOfRows(100, 4) }] }),
    'xlsx',
    caps,
    newReadWork(),
  ).sheet(0);
  expect(sheet.colCount).toBe(4);
  expect(sheet.rowCount).toBe(75);
  expect(sheet.isTruncated).toBe(true);
});

test('cells beyond the column cap are dropped and the sheet is marked truncated', async () => {
  const sheet = await openBook(
    xlsxBytes({ sheets: [{ name: 'S', body: sheetOfRows(2, 5) }] }),
    'xlsx',
    { ...DEFAULT_CAPS, maxCols: 3 },
    newReadWork(),
  ).sheet(0);
  expect(sheet.colCount).toBe(3);
  expect(sheet.isTruncated).toBe(true);
});

test('a part with a DOCTYPE is refused, so no entity can expand', async () => {
  const doctype =
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa">]><worksheet><sheetData/></worksheet>';
  const bytes = xlsxBytes({
    sheets: [{ name: 'S', body: '' }],
    parts: { 'xl/worksheets/sheet1.xml': doctype },
  });
  await expect(openBook(bytes, 'xlsx', DEFAULT_CAPS, newReadWork()).sheet(0)).rejects.toMatchObject({
    kind: 'load_error',
    message: expect.stringContaining('DOCTYPE'),
  });
});

test('a file that is not a zip is a load_error, and an encrypted workbook is password_protected', () => {
  expect(
    rejection(() => openBook(strToU8('just some text, not a workbook'), 'xlsx', DEFAULT_CAPS, newReadWork()))
      .kind,
  ).toBe('load_error');
  const compoundFile = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  expect(rejection(() => openBook(compoundFile, 'xlsx', DEFAULT_CAPS, newReadWork())).kind).toBe(
    'password_protected',
  );
});
