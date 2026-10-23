import { createMemoryAdapter } from '@scope/core/memory';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { httpAdapter } from '@scope/core/http';
import { textRenderer, unsupportedRenderer, Workspace } from '@scope/workspace';
import '@scope/workspace/styles.css';
import { docxBytes, paragraph } from '../../docx/test/fixtures/docx';
import { blankPages, pdfBytes } from '../../pdf/test/fixtures/pdf';
import Files from './quickstart/page';

const FILES = {
  'main.ts': 'export const answer = 42;\n',
  'notes.md': '# Title\n',
  'plain.txt': 'hello',
  'report.pdf': pdfBytes({ pages: blankPages(1) }),
  'letter.docx': docxBytes({ body: paragraph('Hello') }),
  'table.csv': 'a,b\n1,2\n',
};

function serveFilesFromMemory(): void {
  const memory = createMemoryAdapter({ files: FILES });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    const route = url.pathname.replace('/api/files/', '');
    const path = url.searchParams.get('path') ?? '';
    if (route === 'list') {
      const entries = await memory.list(path, { depth: Number(url.searchParams.get('depth') ?? 1) });
      return Response.json({ entries });
    }
    if (route === 'stat') return Response.json({ entry: await memory.stat!(path, {}) });
    if (route === 'read') return new Response(await memory.read(path, 'arrayBuffer'));
    return new Response('not served', { status: 404 });
  });
}

performance.setResourceTimingBufferSize(10_000);

afterEach(() => vi.unstubAllGlobals());

const treeRow = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role=treeitem]')].find((row) =>
    row.textContent?.includes(name),
  );
const part = (name: string): Element | null => document.querySelector(`[data-fs-part=${name}]`);

test('the quick start renders the workspace and lists the files', async () => {
  serveFilesFromMemory();
  await render(<Files />);
  await expect.poll(() => treeRow('main.ts')).toBeDefined();
  expect(part('workspace')).not.toBeNull();
});

const FIRST_LOAD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

const loadedModules = (): string[] => performance.getEntriesByType('resource').map((entry) => entry.name);
const hasLoaded = (module: string): boolean => loadedModules().some((url) => url.includes(`/${module}.`));

test.each([
  ['main.ts', 'code-viewer', 'CodeMirrorEditor'],
  ['notes.md', 'md-viewer', 'LexicalMarkdownEditor'],
  ['report.pdf', 'pdf-viewer', 'PdfDocumentView'],
  ['letter.docx', 'docx-viewer', 'DocxDocument'],
  ['table.csv', 'sheet-viewer', 'SpreadsheetDocument'],
])(
  'opening %s mounts %s, and loads %s only then',
  async (name, viewerPart, lazyModule) => {
    serveFilesFromMemory();
    await render(<Files />);
    await expect.poll(() => treeRow(name)).toBeDefined();
    expect(hasLoaded(lazyModule)).toBe(false);
    treeRow(name)!.click();
    await expect.poll(() => part(viewerPart), { timeout: FIRST_LOAD_TIMEOUT_MS }).not.toBeNull();
    expect(hasLoaded(lazyModule)).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

test('opening plain text mounts the built-in text viewer', async () => {
  serveFilesFromMemory();
  await render(<Files />);
  await expect.poll(() => treeRow('plain.txt')).toBeDefined();
  treeRow('plain.txt')!.click();
  await expect.poll(() => part('text-viewer')).not.toBeNull();
});

test("the preset's styles.css brings in the default theme through its imports", async () => {
  serveFilesFromMemory();
  await render(<Files />);
  expect(getComputedStyle(document.documentElement).getPropertyValue('--fs-accent').trim()).not.toBe('');
});

test('a renderers prop passed to the preset replaces the defaults', async () => {
  serveFilesFromMemory();
  const textOnly = [textRenderer, unsupportedRenderer];
  await render(<Workspace adapter={httpAdapter('/api/files')} renderers={textOnly} />);
  await expect.poll(() => treeRow('main.ts')).toBeDefined();
  treeRow('main.ts')!.click();
  await expect.poll(() => part('text-viewer')).not.toBeNull();
  expect(part('code-viewer')).toBeNull();
});
