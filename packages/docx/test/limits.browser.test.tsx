import type * as DocxPreview from 'docx-preview';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeEach, expect, test, vi } from 'vitest';
import { DocumentLimitExceeded } from '../src/limits';
import { renderDocx } from '../src/renderDocx';
import { docxBytes, PAGE_BREAK, paragraph, picture, WORD_NAMESPACES } from './fixtures/docx';

const work = vi.hoisted(() => ({ parsed: 0, rendered: 0 }));

vi.mock('docx-preview', async (importOriginal) => {
  const original = await importOriginal<typeof DocxPreview>();
  return {
    ...original,
    parseAsync: (...args: Parameters<typeof original.parseAsync>) => {
      work.parsed++;
      return original.parseAsync(...args);
    },
    renderDocument: (...args: Parameters<typeof original.renderDocument>) => {
      work.rendered++;
      return original.renderDocument(...args);
    },
  };
});

beforeEach(() => {
  work.parsed = 0;
  work.rendered = 0;
});

const signal = new AbortController().signal;
const render = (bytes: Uint8Array): ReturnType<typeof renderDocx> => renderDocx(bytes.slice().buffer, signal);
const textOf = (nodes: Node[]): string => nodes.map((node) => node.textContent).join('');

function headerOnEveryPage(headerParagraphs: number, pageBreaks: number): Uint8Array {
  const sectionWithHeader =
    '<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rH"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr></w:p>';
  return docxBytes({
    body: PAGE_BREAK.repeat(pageBreaks) + sectionWithHeader,
    relationships: [{ id: 'rH', type: 'header', target: 'header1.xml' }],
    parts: {
      'word/header1.xml': `<w:hdr ${WORD_NAMESPACES}>${paragraph('H').repeat(headerParagraphs)}</w:hdr>`,
    },
  });
}

function footnoteReferences(noteParagraphs: number, references: number): Uint8Array {
  return docxBytes({
    body: `<w:p>${'<w:r><w:footnoteReference w:id="1"/></w:r>'.repeat(references)}</w:p>`,
    relationships: [{ id: 'rF', type: 'footnotes', target: 'footnotes.xml' }],
    parts: {
      'word/footnotes.xml':
        `<w:footnotes ${WORD_NAMESPACES}><w:footnote w:id="1">` +
        `${paragraph('N').repeat(noteParagraphs)}</w:footnote></w:footnotes>`,
    },
  });
}

function numbering(levels: number, lists: number): Uint8Array {
  const level = '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>';
  const list = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  return docxBytes({
    body: paragraph('x'),
    relationships: [{ id: 'rN', type: 'numbering', target: 'numbering.xml' }],
    parts: {
      'word/numbering.xml':
        `<w:numbering ${WORD_NAMESPACES}><w:abstractNum w:abstractNumId="0">${level.repeat(levels)}` +
        `</w:abstractNum>${list.repeat(lists)}</w:numbering>`,
    },
  });
}

function imageReferences(imageBytes: number, references: number): Uint8Array {
  return docxBytes({
    body: picture('rI').repeat(references),
    relationships: [{ id: 'rI', type: 'image', target: 'media/a.png' }],
    parts: { 'word/media/a.png': new Uint8Array(imageBytes).fill(1) },
  });
}

test('a header is rendered once per page, as counted: 5 page breaks show it on 6 pages', async () => {
  const rendered = await render(headerOnEveryPage(1, 5));
  expect(textOf(rendered.nodes).match(/H/g)).toHaveLength(6);
  expect(work).toEqual({ parsed: 1, rendered: 1 });
});

test('a 1,000-paragraph header on 1,000 pages is refused after parsing, without rendering', async () => {
  await expect(render(headerOnEveryPage(1000, 999))).rejects.toThrow(DocumentLimitExceeded);
  expect(work).toEqual({ parsed: 1, rendered: 0 });
});

test('a 1,000-paragraph footnote referenced 1,000 times is refused without rendering', async () => {
  const rendered = await render(footnoteReferences(3, 4));
  expect(textOf(rendered.nodes).match(/N/g)).toHaveLength(12);
  await expect(render(footnoteReferences(1000, 1000))).rejects.toThrow(DocumentLimitExceeded);
  expect(work).toEqual({ parsed: 2, rendered: 1 });
});

test('1,500 lists of 1,500 levels are refused before docx-preview parses anything', async () => {
  await expect(render(numbering(1500, 1500))).rejects.toThrow(/numbering levels/);
  expect(work).toEqual({ parsed: 0, rendered: 0 });
  await expect(render(numbering(9, 50))).resolves.toHaveProperty('nodes');
});

test('a 4 MiB image shown 40 times is refused without rendering; shown 10 times it renders', async () => {
  const fourMebibytes = 4 * 1024 * 1024;
  await expect(render(imageReferences(fourMebibytes, 40))).rejects.toThrow(/bytes of images/);
  expect(work).toEqual({ parsed: 1, rendered: 0 });
  const rendered = await render(imageReferences(fourMebibytes, 10));
  const images = rendered.nodes.flatMap((node) => [...(node as Element).querySelectorAll('img')]);
  expect(images).toHaveLength(10);
});

test('a billion-laughs document.xml is refused before docx-preview parses anything', async () => {
  const laughs = Array.from({ length: 9 }, (_, level) => {
    const previous = level === 0 ? 'lol' : `lol${level}`;
    return `<!ENTITY lol${level + 1} "${`&${previous};`.repeat(10)}">`;
  }).join('');
  const zip = docxBytes({ body: paragraph('&lol9;') });
  const document = new TextDecoder().decode(unzipSync(zip)['word/document.xml']);
  const withDoctype = document.replace(
    '<w:document',
    `<!DOCTYPE w:document [<!ENTITY lol "lol">${laughs}]><w:document`,
  );
  const files = { ...unzipSync(zip), 'word/document.xml': strToU8(withDoctype) };
  await expect(render(zipSync(files))).rejects.toThrow(/declares a document type/);
  expect(work).toEqual({ parsed: 0, rendered: 0 });
});

test('an embedded HTML chunk that starts with <!DOCTYPE html> no longer stops the document; it is never shown', async () => {
  const rendered = await render(
    docxBytes({
      body: paragraph('Body text') + '<w:altChunk r:id="rChunk"/>',
      relationships: [{ id: 'rChunk', type: 'aFChunk', target: 'afchunk.htm' }],
      parts: {
        'word/afchunk.htm': '<!DOCTYPE html><html><body><p>chunk text</p><script>x()</script></body></html>',
      },
    }),
  );
  expect(textOf(rendered.nodes)).toContain('Body text');
  expect(textOf(rendered.nodes)).not.toContain('chunk text');
  expect(rendered.nodes.flatMap((node) => [...(node as Element).querySelectorAll('iframe, script')])).toEqual(
    [],
  );
  expect(work).toEqual({ parsed: 1, rendered: 1 });
});
