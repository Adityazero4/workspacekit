import axe from 'axe-core';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { SpreadsheetViewer, type SpreadsheetViewerProps } from '../src';
import { inlineCell, numberCell, sheetData, xlsxBytes, type FixtureWorkbook } from './support/xlsxFixture';

afterEach(() => cleanup());

const FOCUS_TIMEOUT_MS = 5_000;

const OPEN_TIMEOUT_MS = 10_000;

function mountViewer(props: SpreadsheetViewerProps): Promise<unknown> {
  return render(
    <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'column' }}>
      <SpreadsheetViewer {...props} />
    </div>,
  );
}

const workbook = (definition: FixtureWorkbook): Uint8Array => xlsxBytes(definition);
const csv = (text: string): Uint8Array => new TextEncoder().encode(text);
const part = (name: string): HTMLElement | null => document.querySelector(`[data-fs-part=${name}]`);
const untilGrid = (): Promise<void> =>
  expect.poll(() => document.querySelector('[role=gridcell]'), { timeout: OPEN_TIMEOUT_MS }).not.toBeNull();

const cellAt = (row: number, col: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[role=row][aria-rowindex="${row + 2}"] [role=gridcell][aria-colindex="${col + 2}"]`,
  );
const rowNumbers = (): string[] =>
  [...document.querySelectorAll('[role=rowheader]')].map((header) => header.textContent ?? '');

function workerCounting(): { workerFactory: () => Worker; searches: () => number } {
  let searches = 0;
  return {
    searches: () => searches,
    workerFactory: () => {
      const worker = new Worker(new URL('../src/reader/worker.ts', import.meta.url), { type: 'module' });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: { type?: string }) => {
        if (message.type === 'search') searches++;
        post(message);
      };
      return worker;
    },
  };
}

test('spill and #### follow the rules, measured on a canvas', async () => {
  const long = 'A heading far wider than one column';
  const rows = [
    [inlineCell('A1', long)],
    [inlineCell('A2', long), inlineCell('B2', 'x')],
    [numberCell('A3', 123456789012345)],
    [numberCell('A4', 7)],
  ];
  const cols = '<cols><col min="1" max="1" width="6" customWidth="1"/></cols>';
  await mountViewer({
    src: workbook({ sheets: [{ name: 'S', body: cols + sheetData(rows) }] }),
    fileName: 'spill.xlsx',
  });
  await untilGrid();
  const columnWidth = cellAt(3, 1)!.getBoundingClientRect().left - cellAt(3, 0)!.getBoundingClientRect().left;
  await expect.poll(() => cellAt(0, 0)!.getBoundingClientRect().width).toBeGreaterThan(columnWidth * 2);
  expect(cellAt(1, 0)!.getBoundingClientRect().width).toBeCloseTo(columnWidth, 0);
  expect(cellAt(2, 0)!.textContent).toMatch(/^#+$/);
  expect(cellAt(3, 0)!.textContent).toBe('7');
});

test('wrap modes; hidden rows are left out but keep their row numbers', async () => {
  const styles = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="3"><xf/><xf><alignment wrapText="1"/></xf><xf><alignment shrinkToFit="1"/></xf></cellXfs></styleSheet>`;
  const body = [
    '<sheetData>',
    '<row r="1" ht="45"><c r="A1" s="1" t="inlineStr"><is><t>wrapped words that need two lines</t></is></c><c r="C1" s="2" t="inlineStr"><is><t>clipped text that would spill</t></is></c></row>',
    '<row r="2" hidden="1"><c r="A2"><v>2</v></c></row>',
    '<row r="3"><c r="A3"><v>3</v></c></row>',
    '</sheetData>',
  ].join('');
  await mountViewer({ src: workbook({ sheets: [{ name: 'S', body }], styles }), fileName: 'wrap.xlsx' });
  await untilGrid();
  expect(rowNumbers().slice(0, 3)).toEqual(['1', '3', '4']);
  expect(getComputedStyle(cellAt(0, 0)!).whiteSpace).toBe('pre-wrap');
  const clipped = cellAt(0, 2)!;
  expect(clipped.getBoundingClientRect().width).toBeLessThan(80);
  expect(clipped.scrollWidth).toBeGreaterThan(clipped.clientWidth);
});

test('a column resizes by dragging its edge, and a double-click fits it to its text', async () => {
  const text = 'a fairly long piece of text';
  await mountViewer({ src: csv(`${text},b\nc,d`), fileName: 'resize.csv' });
  await untilGrid();
  const header = (): HTMLElement =>
    document.querySelector<HTMLElement>('[role=columnheader][aria-colindex="2"]')!;
  const handle = header().querySelector<HTMLElement>('[data-fs-part=sheet-column-resizer]')!;
  const start = header().getBoundingClientRect();
  const pointer = { pointerId: 1, bubbles: true, button: 0 };
  handle.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: start.right }));
  handle.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: start.right + 300 }));
  handle.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: start.right + 300 }));
  await expect
    .poll(() => Math.round(header().getBoundingClientRect().width))
    .toBe(Math.round(start.width + 300));
  await userEvent.dblClick(handle);
  await expect.poll(() => header().getBoundingClientRect().width).toBeLessThan(start.width + 300);
  expect(header().getBoundingClientRect().width).toBeGreaterThan(text.length * 4);
  expect(cellAt(0, 0)!.getBoundingClientRect().width).toBeCloseTo(header().getBoundingClientRect().width, 0);
});

test('sheet tabs are a tablist: hidden sheets are left out and the arrow keys switch sheets', async () => {
  const sheets = [
    { name: 'First', body: sheetData([[inlineCell('A1', 'on the first sheet')]]) },
    { name: 'Secret', body: sheetData([[inlineCell('A1', 'hidden')]]), state: 'hidden' as const },
    { name: 'Second', body: sheetData([[inlineCell('A1', 'on the second sheet')]]) },
  ];
  await mountViewer({ src: workbook({ sheets }), fileName: 'tabs.xlsx' });
  await untilGrid();
  const tabs = [...document.querySelectorAll<HTMLElement>('[role=tablist] [role=tab]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual(['First', 'Second']);
  expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  expect(part('sheet-panel')!.getAttribute('role')).toBe('tabpanel');
  tabs[0]!.focus();
  await expect.poll(() => document.activeElement, { timeout: FOCUS_TIMEOUT_MS }).toBe(tabs[0]);
  await userEvent.keyboard('{ArrowRight}');
  await expect.poll(() => cellAt(0, 0)?.textContent).toBe('on the second sheet');
  expect(document.activeElement?.textContent).toBe('Second');
  expect(part('sheet-panel')!.getAttribute('aria-labelledby')).toBe(document.activeElement!.id);
});

test('search finds cells across the sheet, with the work done in the worker', async () => {
  const rows = Array.from({ length: 3_000 }, (_, row) => `row ${row},${row === 2_500 ? 'needle' : 'hay'}`);
  rows[10] = 'NEEDLE here,hay';
  const { workerFactory, searches } = workerCounting();
  await mountViewer({ src: csv(rows.join('\n')), fileName: 'search.csv', workerFactory });
  await untilGrid();
  const input = document.querySelector<HTMLInputElement>('input[type=search]')!;
  await userEvent.type(input, 'needle');
  await expect.poll(() => part('sheet-search-status')!.textContent).toBe('1 of 2');
  expect(searches()).toBeGreaterThan(0);
  expect(part('sheet-selection')!.textContent).toBe('A11: NEEDLE here');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => part('sheet-search-status')!.textContent).toBe('2 of 2');
  await expect.poll(() => cellAt(2_500, 1)?.textContent).toBe('needle');
  expect(part('sheet-selection')!.textContent).toBe('B2501: needle');
});

test('a refresh keeps the sheet, the scroll position and the selected cell', async () => {
  const sheetsWith = (marker: string): FixtureWorkbook => ({
    sheets: [
      { name: 'One', body: sheetData([[inlineCell('A1', 'one')]]) },
      {
        name: 'Two',
        body: sheetData(
          Array.from({ length: 400 }, (_, row) => [
            numberCell(`A${row + 1}`, row),
            inlineCell(`B${row + 1}`, `${marker} ${row}`),
          ]),
        ),
      },
    ],
  });
  const screen = (await mountViewer({ src: workbook(sheetsWith('old')), fileName: 'live.xlsx' })) as {
    rerender: (element: React.JSX.Element) => Promise<void>;
  };
  await untilGrid();
  await userEvent.click(document.querySelectorAll<HTMLElement>('[role=tab]')[1]!);
  await expect.poll(() => cellAt(0, 1)?.textContent).toBe('old 0');
  await userEvent.click(cellAt(0, 0)!);
  await expect.poll(() => document.activeElement === cellAt(0, 0), { timeout: FOCUS_TIMEOUT_MS }).toBe(true);
  await userEvent.keyboard('{ArrowRight}{ArrowDown}{ArrowDown}');
  const viewport = part('sheet-grid-viewport')!;
  viewport.scrollTop = 3_000;
  await expect.poll(() => cellAt(160, 1)?.textContent).toBe('old 160');
  await screen.rerender(
    <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'column' }}>
      <SpreadsheetViewer src={workbook(sheetsWith('new'))} fileName="live.xlsx" />
    </div>,
  );
  await expect.poll(() => cellAt(160, 1)?.textContent).toBe('new 160');
  expect(document.querySelector('[role=tab][aria-selected=true]')!.textContent).toBe('Two');
  expect(part('sheet-grid-viewport')!.scrollTop).toBe(3_000);
  expect(part('sheet-selection')!.textContent).toBe('B3: new 2');
});

test('a truncated sheet says it shows the first N rows', async () => {
  const lines = Array.from({ length: 20_005 }, (_, row) => `${row}`);
  await mountViewer({ src: csv(lines.join('\n')), fileName: 'long.csv' });
  await untilGrid();
  expect(part('sheet-notice')!.textContent).toBe('Showing the first 20,000 rows.');
});

test('an empty sheet shows "No data available"', async () => {
  await mountViewer({
    src: workbook({ sheets: [{ name: 'Empty', body: '<sheetData/>' }] }),
    fileName: 'empty.xlsx',
  });
  await expect
    .poll(() => part('sheet-empty')?.textContent, { timeout: OPEN_TIMEOUT_MS })
    .toBe('No data available');
});

test('xls without SheetJS says how to add it', async () => {
  await mountViewer({ src: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), fileName: 'legacy.xls' });
  await expect
    .poll(() => part('sheet-error')?.textContent ?? '', { timeout: OPEN_TIMEOUT_MS })
    .toContain("engines: { xlsx: () => import('xlsx') }");
});

test.each(['light', 'dark'] as const)('axe clean (%s)', async (theme) => {
  const sheets = [
    {
      name: 'Data',
      body: `<sheetViews><sheetView><pane ySplit="1" xSplit="1" state="frozen"/></sheetView></sheetViews>${sheetData(
        [
          [inlineCell('A1', 'Name'), inlineCell('B1', 'Total')],
          [inlineCell('A2', 'Ada'), numberCell('B2', 3)],
        ],
      )}<mergeCells><mergeCell ref="C1:D2"/></mergeCells>`,
    },
    { name: 'Notes', body: sheetData([[inlineCell('A1', 'notes')]]) },
  ];
  await mountViewer({ src: workbook({ sheets }), fileName: 'axe.xlsx', theme });
  await untilGrid();
  const results = await axe.run(part('sheet-viewer')!);
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});
