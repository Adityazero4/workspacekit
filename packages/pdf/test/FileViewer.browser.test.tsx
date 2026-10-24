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
import { render } from 'vitest-browser-react';
import '../dist/styles.css';
import { pdfRenderer } from '../src';
import { pdfBytes } from './fixtures/pdf';

const LOAD_ERROR_COPY = "This file couldn't be opened. Try again, or download it.";
const SLOW_PDF_WORK = { timeout: 15_000 };
const renderers = [
  pdfRenderer({ classNames: { 'pdf-viewer': 'my-pdf', 'pdf-toolbar': 'my-toolbar' } }),
  ...lightRenderers,
];

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

test('the registry entry shows a .pdf from the adapter, with the factory classNames on its parts', async () => {
  await mountViewer(
    { 'docs/report.pdf': pdfBytes({ pages: [{ text: 'Quarterly report' }, {}] }) },
    'docs/report.pdf',
  );
  await expect
    .poll(() => document.querySelector('.textLayer')?.textContent, SLOW_PDF_WORK)
    .toContain('Quarterly report');
  expect(document.querySelector('[data-fs-part=pdf-viewer]')!.classList.contains('my-pdf')).toBe(true);
  expect(document.querySelector('[data-fs-part=pdf-toolbar]')!.className).toBe('my-toolbar');
  expect(document.querySelector('[data-fs-part=pdf-page-indicator]')!.textContent).toBe('Page 1 of 2');
});

test('a file that is not a PDF shows the load_error view', async () => {
  await mountViewer({ 'broken.pdf': 'not a pdf' }, 'broken.pdf');
  await expect.poll(() => document.body.textContent, SLOW_PDF_WORK).toContain(LOAD_ERROR_COPY);
});
