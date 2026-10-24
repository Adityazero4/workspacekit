import { statusOf } from '@workspacekit/core';
import { createMemoryAdapter } from '@workspacekit/core/memory';
import {
  FileSystemProvider,
  FileViewer,
  lightRenderers,
  useFileSystem,
  type FileSystemContext,
} from '@workspacekit/react';
import '@workspacekit/react/styles.css';
import { useEffect } from 'react';
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { spreadsheetRenderer } from '../src';
import { inlineCell, sheetData, xlsxBytes } from './support/xlsxFixture';

const OPEN_TIMEOUT_MS = 10_000;
const renderers = [spreadsheetRenderer({ classNames: { 'sheet-viewer': 'my-sheet' } }), ...lightRenderers];

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

async function mountViewer(files: Record<string, string | Uint8Array>, path: string): Promise<void> {
  let fs: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={createMemoryAdapter({ files })}>
      <div style={{ height: 500, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path={path} renderers={renderers} />
      </div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
}

test('the registry entry shows an .xlsx from the adapter, with the factory classNames on its root', async () => {
  await mountViewer(
    { 'q3.xlsx': xlsxBytes({ sheets: [{ name: 'Q3', body: sheetData([[inlineCell('A1', 'revenue')]]) }] }) },
    'q3.xlsx',
  );
  await expect
    .poll(() => document.querySelector('[role=gridcell]')?.textContent, { timeout: OPEN_TIMEOUT_MS })
    .toBe('revenue');
  expect(document.querySelector('[data-fs-part=sheet-viewer]')!.className).toBe('my-sheet');
  expect(document.querySelector('[role=grid]')!.getAttribute('aria-label')).toBe('Q3');
});

test('a CSV has a raw mode that shows it as text', async () => {
  await mountViewer({ 'people.csv': 'name;age\nAda;36' }, 'people.csv');
  await expect
    .poll(() => document.querySelector('[role=gridcell]')?.textContent, { timeout: OPEN_TIMEOUT_MS })
    .toBe('name');
  await userEvent.click(
    document.querySelector<HTMLElement>('[data-fs-part=viewer-modes] button:last-child')!,
  );
  await expect.poll(() => document.querySelector('[role=grid]')).toBeNull();
  await expect
    .poll(() => document.querySelector('[data-fs-part=viewer]')?.textContent ?? '')
    .toContain('Ada;36');
});
