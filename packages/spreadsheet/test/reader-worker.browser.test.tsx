import { expect, test } from 'vitest';
import { createWorkerReader } from '../src/reader/client';
import { numberCell, sheetData, xlsxBytes } from './support/xlsxFixture';

const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

test('the default module worker reads an xlsx and searches it, leaving the caller its buffer', async () => {
  const reader = createWorkerReader();
  const data = bufferOf(
    xlsxBytes({
      sheets: [{ name: 'Totals', body: sheetData([[numberCell('A1', 41), '<c r="B1"><f>A1+1</f></c>']]) }],
    }),
  );
  try {
    expect(await reader.open(data, 'xlsx')).toEqual({ sheets: [{ name: 'Totals', isHidden: false }] });
    expect(data.byteLength).toBeGreaterThan(0);
    const sheet = await reader.sheet(0);
    expect(sheet.cellTexts).toEqual(['41', '42']);
    expect(await reader.search(0, '42')).toEqual([{ row: 0, col: 1 }]);
  } finally {
    reader.dispose();
  }
});

test('a CSV opens in the worker too', async () => {
  const reader = createWorkerReader();
  try {
    await reader.open(bufferOf(new TextEncoder().encode('a;b\n1;2')), 'csv');
    expect((await reader.sheet(0)).cellTexts).toEqual(['a', 'b', '1', '2']);
  } finally {
    reader.dispose();
  }
});
