import { codeRenderer } from '@scope/code';
import { docxRenderer } from '@scope/docx';
import { markdownRenderer } from '@scope/markdown';
import { pdfRenderer } from '@scope/pdf';
import { pptxRenderer } from '@scope/pptx';
import { spreadsheetRenderer } from '@scope/spreadsheet';
import type * as CodePackage from '@scope/code';
import type * as DocxPackage from '@scope/docx';
import type * as MarkdownPackage from '@scope/markdown';
import type * as PdfPackage from '@scope/pdf';
import type * as PptxPackage from '@scope/pptx';
import type * as SpreadsheetPackage from '@scope/spreadsheet';
import { expect, test, vi } from 'vitest';
import { allRenderers, type AllRenderersOptions } from '../src';

vi.mock('@scope/code', async (importOriginal) => {
  const original = await importOriginal<typeof CodePackage>();
  return { ...original, codeRenderer: vi.fn(original.codeRenderer) };
});
vi.mock('@scope/docx', async (importOriginal) => {
  const original = await importOriginal<typeof DocxPackage>();
  return { ...original, docxRenderer: vi.fn(original.docxRenderer) };
});
vi.mock('@scope/markdown', async (importOriginal) => {
  const original = await importOriginal<typeof MarkdownPackage>();
  return { ...original, markdownRenderer: vi.fn(original.markdownRenderer) };
});
vi.mock('@scope/pdf', async (importOriginal) => {
  const original = await importOriginal<typeof PdfPackage>();
  return { ...original, pdfRenderer: vi.fn(original.pdfRenderer) };
});
vi.mock('@scope/pptx', async (importOriginal) => {
  const original = await importOriginal<typeof PptxPackage>();
  return { ...original, pptxRenderer: vi.fn(original.pptxRenderer) };
});
vi.mock('@scope/spreadsheet', async (importOriginal) => {
  const original = await importOriginal<typeof SpreadsheetPackage>();
  return { ...original, spreadsheetRenderer: vi.fn(original.spreadsheetRenderer) };
});

test('allRenderers gives each package its own options, in the same precedence order', () => {
  const xlsx = (): Promise<unknown> => Promise.resolve({});
  const options: AllRenderersOptions = {
    pdf: { workerSrc: '/pdfjs/pdf.worker.min.mjs', assets: { cMapUrl: '/pdfjs/cmaps/' } },
    docx: { classNames: { 'docx-document': 'pages' } },
    pptx: { externalMedia: 'allow' },
    spreadsheet: { engines: { xlsx } },
    markdown: { classNames: { 'md-editor': 'prose' } },
    code: { nonce: 'csp-nonce' },
  };
  vi.clearAllMocks();
  const renderers = allRenderers(options);
  expect(pdfRenderer).toHaveBeenCalledExactlyOnceWith(options.pdf);
  expect(docxRenderer).toHaveBeenCalledExactlyOnceWith(options.docx);
  expect(pptxRenderer).toHaveBeenCalledExactlyOnceWith(options.pptx);
  expect(spreadsheetRenderer).toHaveBeenCalledExactlyOnceWith(options.spreadsheet);
  expect(codeRenderer).toHaveBeenCalledExactlyOnceWith(options.code);
  const code = vi.mocked(codeRenderer).mock.results[0]!.value;
  expect(markdownRenderer).toHaveBeenCalledExactlyOnceWith({ ...options.markdown, source: code });
  expect(renderers.slice(0, 6).map((renderer) => renderer.id)).toEqual([
    'pdf',
    'docx',
    'pptx',
    'spreadsheet',
    'markdown',
    'code',
  ]);
  expect(renderers[5]).toBe(code);
});
