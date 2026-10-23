import { statusOf } from '@scope/core';
import { createMemoryAdapter } from '@scope/core/memory';
import {
  FileSystemProvider,
  FileViewer,
  lightRenderers,
  useFileSystem,
  type FileSystemContext,
} from '@scope/react';
import '@scope/react/styles.css';
import { useEffect } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import '../src/styles.css';
import { DOCX_MAX_BYTES, docxRenderer } from '../src';
import { docxBytes, PAGE_BREAK, paragraph, WORD_NAMESPACES } from './fixtures/docx';

const LOAD_ERROR_COPY = "This file couldn't be opened. Try again, or download it.";
const TOO_LARGE_COPY = 'This file is too large to preview. Download it instead.';
const renderers = [
  docxRenderer({ classNames: { 'docx-viewer': 'my-docx', 'docx-document': 'my-document' } }),
  ...lightRenderers,
];

function Capture(props: { onContext: (fs: FileSystemContext) => void }): null {
  const fs = useFileSystem();
  useEffect(() => void props.onContext(fs));
  return null;
}

async function mountViewer(
  files: Record<string, string | Uint8Array>,
  path: string,
): Promise<ReturnType<typeof createMemoryAdapter>> {
  const memory = createMemoryAdapter({ files });
  let fs: FileSystemContext | undefined;
  await render(
    <FileSystemProvider adapter={memory}>
      <div style={{ height: 500, display: 'flex', flexDirection: 'column' }}>
        <FileViewer path={path} renderers={renderers} />
      </div>
      <Capture onContext={(context) => (fs = context)} />
    </FileSystemProvider>,
  );
  await expect.poll(() => fs && statusOf(fs.store.getSnapshot().tree, '')).toBe('loaded');
  return memory;
}

const documentHost = (): HTMLElement | null => document.querySelector('[data-fs-part=docx-document]');

test('the registry entry shows a .docx from the adapter, with the factory classNames on its parts', async () => {
  await mountViewer(
    { 'docs/report.docx': docxBytes({ body: paragraph('Quarterly report') }) },
    'docs/report.docx',
  );
  await expect.poll(() => documentHost()?.shadowRoot?.textContent).toContain('Quarterly report');
  expect(document.querySelector('[data-fs-part=docx-viewer]')!.className).toBe('my-docx');
  expect(documentHost()!.className).toBe('my-document');
  expect(documentHost()!.getAttribute('aria-label')).toBe('Contents of report.docx');
});

test('.doc shows unsupported; over maxBytes shows too_large', async () => {
  await mountViewer(
    { 'old.doc': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
    'old.doc',
  );
  await expect
    .poll(() => document.querySelector('[data-fs-part=viewer-unsupported-message]')?.textContent)
    .toBe('No preview for this file type.');
  expect(documentHost()).toBeNull();

  await mountViewer({ 'huge.docx': new Uint8Array(DOCX_MAX_BYTES + 1) }, 'huge.docx');
  await expect.poll(() => document.body.textContent).toContain(TOO_LARGE_COPY);
  expect(documentHost()).toBeNull();
});

test('a .docx that is not a zip shows the load_error view', async () => {
  await mountViewer({ 'broken.docx': 'not a zip' }, 'broken.docx');
  await expect.poll(() => document.body.textContent).toContain(LOAD_ERROR_COPY);
});

test('a refresh that cannot be opened keeps the earlier version and is no longer busy', async () => {
  const memory = await mountViewer({ 'a.docx': docxBytes({ body: paragraph('First version') }) }, 'a.docx');
  await expect.poll(() => documentHost()?.shadowRoot?.textContent).toContain('First version');
  expect(documentHost()!.hasAttribute('aria-busy')).toBe(false);

  await memory.write!('a.docx', 'not a zip any more');
  await expect.poll(() => document.body.textContent).toContain(LOAD_ERROR_COPY);
  await expect.poll(() => documentHost()!.hasAttribute('aria-busy')).toBe(false);
  expect(documentHost()!.shadowRoot!.textContent).toContain('First version');
});

test('a document refused for the work it would cost shows too_large, with Download offered', async () => {
  const sectionWithHeader =
    '<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rH"/></w:sectPr></w:pPr></w:p>';
  const amplified = docxBytes({
    body: PAGE_BREAK.repeat(999) + sectionWithHeader,
    relationships: [{ id: 'rH', type: 'header', target: 'header1.xml' }],
    parts: { 'word/header1.xml': `<w:hdr ${WORD_NAMESPACES}>${paragraph('H').repeat(1000)}</w:hdr>` },
  });
  await mountViewer({ 'pages.docx': amplified }, 'pages.docx');
  await expect.poll(() => document.querySelector('[role=alert]')?.textContent).toContain(TOO_LARGE_COPY);
  const buttons = [...document.querySelectorAll('button')].map((button) => button.textContent);
  expect(buttons).toContain('Download');
});
