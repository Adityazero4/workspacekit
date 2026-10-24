import { createRoot } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '@workspacekit/react/styles.css';
import '../src/styles.css';
import { SpreadsheetViewer } from '../src';
import type { CellAddress } from '../src/grid/model';
import { SearchBar } from '../src/SearchBar';
import { SheetTabs } from '../src/SheetTabs';
import { lazyWorkerReader } from '../src/workbookSource';
import { inlineCell, sheetData, xlsxBytes } from './support/xlsxFixture';

afterEach(() => cleanup());

const FOCUS_TIMEOUT_MS = 5_000;

const OPEN_TIMEOUT_MS = 10_000;
const part = (name: string): HTMLElement | null => document.querySelector(`[data-fs-part=${name}]`);

function heldPromise<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('search results that arrive after the query was cleared never move the selection', async () => {
  const held = heldPromise<CellAddress[]>();
  const matches: CellAddress[] = [];
  await render(
    <SearchBar find={() => held.promise} onMatch={(cell) => matches.push(cell)} classNames={undefined} />,
  );
  await userEvent.type(document.querySelector<HTMLInputElement>('input[type=search]')!, 'a');
  await userEvent.keyboard('{Escape}');
  held.resolve([{ row: 400, col: 3 }]);
  await held.promise;
  await new Promise((settle) => setTimeout(settle, 0));
  expect(matches).toEqual([]);
  expect(part('sheet-search-status')!.textContent).toBe('');
});

const sheetOfRows = (rows: number): Uint8Array =>
  xlsxBytes({
    sheets: [
      {
        name: 'S',
        body: sheetData(Array.from({ length: rows }, (_, row) => [inlineCell(`A${row + 1}`, `r${row}`)])),
      },
    ],
  });

test('when a refresh shrinks the sheet, the selection moves inside it instead of reading NaN', async () => {
  const frame = (src: Uint8Array): React.JSX.Element => (
    <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'column' }}>
      <SpreadsheetViewer src={src} fileName="live.xlsx" />
    </div>
  );
  const screen = await render(frame(sheetOfRows(300)));
  await expect
    .poll(() => document.querySelector('[role=gridcell]'), { timeout: OPEN_TIMEOUT_MS })
    .not.toBeNull();
  const firstCell = document.querySelector<HTMLElement>('[role=gridcell]')!;
  await userEvent.click(firstCell);
  await expect.poll(() => document.activeElement, { timeout: FOCUS_TIMEOUT_MS }).toBe(firstCell);
  await userEvent.keyboard('{Control>}{End}{/Control}');
  await expect.poll(() => part('sheet-selection')!.textContent).toBe('Z300');
  await screen.rerender(frame(sheetOfRows(10)));
  await expect.poll(() => part('sheet-selection')!.textContent).toBe('Z50');
  expect(part('sheet-selection')!.textContent).not.toContain('NaN');
});

test('the selection readout is not a live region, so moving through cells is not read twice', async () => {
  await render(
    <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'column' }}>
      <SpreadsheetViewer src={sheetOfRows(5)} fileName="quiet.xlsx" />
    </div>,
  );
  await expect.poll(() => part('sheet-selection'), { timeout: OPEN_TIMEOUT_MS }).not.toBeNull();
  const readout = part('sheet-selection')!;
  expect(readout.getAttribute('aria-live')).toBeNull();
  expect(readout.tagName).not.toBe('OUTPUT');
  expect(readout.getAttribute('role')).toBeNull();
});

test('sheet tabs move focus inside a shadow root too', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const mount = document.createElement('div');
  shadow.append(mount);
  const root = createRoot(mount);
  let selected = 0;
  const draw = (): void =>
    root.render(
      <SheetTabs
        sheets={[
          { name: 'One', index: 0 },
          { name: 'Two', index: 1 },
        ]}
        selected={selected}
        panelId="panel"
        idPrefix="tab"
        onSelect={(index) => {
          selected = index;
          draw();
        }}
        classNames={undefined}
      />,
    );
  draw();
  await expect.poll(() => shadow.querySelectorAll('[role=tab]').length).toBe(2);
  shadow.querySelector<HTMLElement>('[role=tab]')!.focus();
  await expect.poll(() => shadow.activeElement?.textContent, { timeout: FOCUS_TIMEOUT_MS }).toBe('One');
  await userEvent.keyboard('{ArrowRight}');
  await expect.poll(() => shadow.activeElement?.textContent, { timeout: FOCUS_TIMEOUT_MS }).toBe('Two');
  root.unmount();
  host.remove();
});

test('a disposed viewer reader never starts a worker again', async () => {
  let started = 0;
  const reader = lazyWorkerReader(() => {
    started++;
    return new Worker(new URL('../src/reader/worker.ts', import.meta.url), { type: 'module' });
  });
  reader.dispose();
  await expect(reader.get().open(new ArrayBuffer(4), 'csv')).rejects.toMatchObject({ name: 'AbortError' });
  expect(started).toBe(0);
});

test('a workbook listing more than 1,024 sheets says it shows the first 1,024', async () => {
  const sheets = Array.from(
    { length: 1_025 },
    (_, index) => `<sheet name="S${index}" sheetId="${index + 1}" r:id="rId1"/>`,
  ).join('');
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
  const src = xlsxBytes({
    sheets: [{ name: 'S', body: sheetData([[inlineCell('A1', 'first')]]) }],
    parts: { 'xl/workbook.xml': workbook },
  });
  await render(
    <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'column' }}>
      <SpreadsheetViewer src={src} fileName="many.xlsx" />
    </div>,
  );
  await expect
    .poll(() => part('sheet-notice')?.textContent, { timeout: OPEN_TIMEOUT_MS })
    .toBe('Showing the first 1,024 sheets.');
  expect(document.querySelectorAll('[role=tab]')).toHaveLength(1_024);
});
