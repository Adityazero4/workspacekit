import { expect, test } from 'vitest';
import { decodeText, readDelimited } from '../src/reader/csv';
import { boundedDelimitedText } from '../src/reader/delimitedBounds';
import { DEFAULT_CAPS } from '../src/reader/types';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const rowsOf = (text: string | Uint8Array, format: 'csv' | 'tsv' = 'csv'): string[][] => {
  const sheet = readDelimited(typeof text === 'string' ? bytesOf(text) : text, format, DEFAULT_CAPS);
  const rows = Array.from({ length: sheet.rowCount }, () => Array<string>(sheet.colCount).fill(''));
  sheet.cellTexts.forEach((cellText, index) => {
    rows[sheet.cellRows[index]!]![sheet.cellCols[index]!] = cellText;
  });
  return rows;
};

test('the delimiter is sniffed: semicolons, tabs and pipes', () => {
  expect(rowsOf('a;b;c\n1;2;3')).toEqual([
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
  expect(rowsOf('a|b\n1|2')).toEqual([
    ['a', 'b'],
    ['1', '2'],
  ]);
  expect(rowsOf('a,b\tc\n1,2\t3', 'tsv')).toEqual([
    ['a,b', 'c'],
    ['1,2', '3'],
  ]);
});

test('a leading sep= line sets the delimiter and is not a row', () => {
  expect(rowsOf('sep=;\r\na,b;c\n1,5;2')).toEqual([
    ['a,b', 'c'],
    ['1,5', '2'],
  ]);
});

test('a UTF-8 byte order mark is dropped', () => {
  expect(rowsOf(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('name,age\nZoë,3')]))).toEqual([
    ['name', 'age'],
    ['Zoë', '3'],
  ]);
  expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('hi');
});

test('bytes that are not UTF-8 are read as Windows-1252', () => {
  expect(
    rowsOf(new Uint8Array([0x93, 0x71, 0x94, 0x2c, 0x80, 0x35, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31])),
  ).toEqual([
    ['“q”', '€5'],
    ['café', '1'],
  ]);
});

test('text that looks like SYLK, DIF or XML is still read as CSV, and formulas show as written', () => {
  expect(rowsOf('ID,Name\n1,=SUM(A1:A2)')).toEqual([
    ['ID', 'Name'],
    ['1', '=SUM(A1:A2)'],
  ]);
  expect(rowsOf('TABLE,0,1\n<b>,x')).toEqual([
    ['TABLE', '0', '1'],
    ['<b>', 'x', ''],
  ]);
});

test('parsing stops at the row cap and the sheet says it is truncated; numbers are marked', () => {
  const text = Array.from({ length: 50 }, (_, row) => `${row},x`).join('\n');
  const sheet = readDelimited(bytesOf(text), 'csv', { ...DEFAULT_CAPS, maxRows: 10 });
  expect(sheet.rowCount).toBe(10);
  expect(sheet.isTruncated).toBe(true);
  expect(sheet.cellKinds.slice(0, 2)).toEqual(['number', 'text']);
  expect([sheet.colWidths[0], sheet.rowHeights[0]]).toEqual([100, 20]);
});

const MEBIBYTE = 1024 * 1024;

test('a row of a million delimiters is cut to the column cap before papaparse builds a single field', () => {
  const bounded = boundedDelimitedText(','.repeat(MEBIBYTE), ',', DEFAULT_CAPS);
  expect(bounded.text.length).toBeLessThanOrEqual(DEFAULT_CAPS.maxCols);
  expect(bounded.isCut).toBe(true);
  const sheet = readDelimited(bytesOf(`a${','.repeat(MEBIBYTE)}\nb`), 'csv', DEFAULT_CAPS);
  expect(sheet.colCount).toBeLessThanOrEqual(DEFAULT_CAPS.maxCols);
  expect(sheet.isTruncated).toBe(true);
});

test('a field of a million escaped quotes keeps 32,767 characters and its closing quote', () => {
  const field = `"${'""'.repeat(MEBIBYTE)}",next`;
  const bounded = boundedDelimitedText(field, ',', DEFAULT_CAPS);
  expect(bounded.text.length).toBeLessThan(2 * DEFAULT_CAPS.maxCellText + 16);
  expect(rowsOf(field)).toEqual([['"'.repeat(DEFAULT_CAPS.maxCellText), 'next']]);
});

test('rows past the cap and cells past the cell budget never reach papaparse', () => {
  const lines = Array.from({ length: 1_000 }, (_, row) => `${row},x,y`).join('\n');
  const firstRows = boundedDelimitedText(lines, ',', { ...DEFAULT_CAPS, maxRows: 10 }).text.split('\n');
  expect(firstRows).toHaveLength(11);
  expect(
    boundedDelimitedText(lines, ',', { ...DEFAULT_CAPS, maxCells: 30 }).text.split('\n').length,
  ).toBeLessThan(12);
  expect(boundedDelimitedText('a,"b,\nc",d\ne', ',', DEFAULT_CAPS)).toEqual({
    text: 'a,"b,\nc",d\ne',
    isCut: false,
  });
});
