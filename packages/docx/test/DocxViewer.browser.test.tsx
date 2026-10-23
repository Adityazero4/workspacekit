import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-react';
import '../src/styles.css';
import { DOCX_MAX_BYTES, DocxViewer, type DocxViewerProps } from '../src';
import { DOCX_LIMITS, DocumentLimitExceeded } from '../src/limits';
import { renderDocx } from '../src/renderDocx';
import {
  bookmarkedParagraph,
  docxBytes,
  FONT_TABLE,
  hyperlink,
  PAGE_BREAK,
  paragraph,
  picture,
  stylesWithFont,
  symbol,
} from './fixtures/docx';

const LOAD_ERROR_COPY = "This file couldn't be opened. Try again, or download it.";
const TOO_LARGE_COPY = 'This file is too large to preview. Download it instead.';
const PROBE_PATH = '/__docx-probe__/';
const probe = (name: string): string => `${location.origin}${PROBE_PATH}${name}`;

afterEach(() => {
  cleanup();
  document.getElementById('Target')?.remove();
});

const sized = (node: ReactNode): ReactNode => (
  <div style={{ height: 480, display: 'flex', flexDirection: 'column' }}>{node}</div>
);

const host = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-fs-part=docx-document]');
const shown = (): ShadowRoot | null => host()?.shadowRoot ?? null;
const shownText = (): string => shown()?.textContent ?? '';

async function showDocx(bytes: Uint8Array, props: Partial<DocxViewerProps> = {}): Promise<ShadowRoot> {
  await render(sized(<DocxViewer src={bytes} fileName="crafted.docx" {...props} />));
  await expect.poll(() => shown()?.querySelector('section')).toBeInstanceOf(HTMLElement);
  return shown()!;
}

function craftedDocx(): Uint8Array {
  return docxBytes({
    body: [
      hyperlink({ id: 'rJs' }, 'javascript link'),
      hyperlink({ id: 'rData' }, 'data link'),
      hyperlink({ id: 'rFile' }, 'file link'),
      hyperlink({ id: 'rWeb' }, 'web link'),
      hyperlink({ id: 'rMail' }, 'mail link'),
      '<w:altChunk r:id="rChunk"/>',
      '<w:p><w:fldSimple w:instr="HYPERLINK &quot;javascript:alert(1)&quot; onmouseover=&quot;alert(1)&quot;">' +
        '<w:r><w:t>simple field</w:t></w:r></w:fldSimple></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText>HYPERLINK "x" &lt;img src=x onerror=alert(1)&gt;</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>complex field</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      picture('rImage'),
      '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>styled paragraph</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:rFonts w:ascii="Probe Sans"/></w:rPr><w:t>embedded font</w:t></w:r></w:p>',
      hyperlink({ anchor: 'Target' }, 'Go to the target'),
    ].join(''),
    relationships: [
      { id: 'rJs', type: 'hyperlink', target: 'javascript:alert(1)', external: true },
      { id: 'rData', type: 'hyperlink', target: 'data:text/html,<script>alert(1)</script>', external: true },
      { id: 'rFile', type: 'hyperlink', target: 'file:///etc/passwd', external: true },
      { id: 'rWeb', type: 'hyperlink', target: 'https://example.com/page', external: true },
      { id: 'rMail', type: 'hyperlink', target: 'mailto:someone@example.com', external: true },
      { id: 'rChunk', type: 'aFChunk', target: 'chunk.htm' },
      { id: 'rImage', type: 'image', target: probe('image.png'), external: true },
      { id: 'rStyles', type: 'styles', target: 'styles.xml' },
      { id: 'rFonts', type: 'fontTable', target: 'fontTable.xml' },
    ],
    parts: {
      'word/chunk.htm':
        '<html><body><p>chunk text</p><script>window.docxChunkRan = true</script>' +
        '<img src="x" onerror="window.docxChunkRan = true"></body></html>',
      'word/styles.xml': stylesWithFont(`X;}.docx{background-image:url(${probe('style.png')})}.y{color:red`),
      'word/fontTable.xml': FONT_TABLE,
    },
    partRelationships: {
      'word/fontTable.xml': [{ id: 'rFont', type: 'font', target: probe('font.ttf'), external: true }],
    },
  });
}

const allElements = (root: ShadowRoot): Element[] => [...root.querySelectorAll('*')];
const styleText = (root: ShadowRoot): string =>
  root.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\n');
const probeRequests = (): string[] =>
  performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes(PROBE_PATH) || name.endsWith('/null'));

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

test('crafted docx: no script, no iframe, only safe links', async () => {
  const root = await showDocx(craftedDocx());

  const forbidden = 'script, iframe, object, embed, form, link, meta, base, style, frame, frameset';
  expect(root.querySelectorAll(forbidden)).toHaveLength(0);
  const eventAttributes = allElements(root).flatMap((element) =>
    element.getAttributeNames().filter((name) => name.toLowerCase().startsWith('on')),
  );
  expect(eventAttributes).toEqual([]);
  expect(shownText()).not.toContain('chunk text');
  expect('docxChunkRan' in window).toBe(false);

  const links = [...root.querySelectorAll('a')].map((link) => ({
    text: link.textContent,
    href: link.getAttribute('href'),
    target: link.getAttribute('target'),
    rel: link.getAttribute('rel'),
  }));
  expect(links).toEqual([
    { text: 'javascript link', href: null, target: null, rel: null },
    { text: 'data link', href: null, target: null, rel: null },
    { text: 'file link', href: null, target: null, rel: null },
    { text: 'web link', href: 'https://example.com/page', target: '_blank', rel: 'noopener noreferrer' },
    { text: 'mail link', href: 'mailto:someone@example.com', target: '_blank', rel: 'noopener noreferrer' },
    { text: 'Go to the target', href: '#Target', target: null, rel: null },
  ]);
});

test('a document with an external image, font or style URL makes no request', async () => {
  const root = await showDocx(craftedDocx());
  expect(root.adoptedStyleSheets.length).toBeGreaterThan(0);
  expect(styleText(root)).toContain('.docx-wrapper');
  expect(styleText(root)).not.toContain(PROBE_PATH);
  expect(styleText(root)).not.toMatch(/url\(\s*["']?(?!data:)/);
  const references = allElements(root).flatMap((element) =>
    element.getAttributeNames().map((name) => element.getAttribute(name)!),
  );
  expect(references.filter((value) => value.includes(PROBE_PATH) || /url\(/i.test(value))).toEqual([]);
  expect(root.querySelectorAll('img[src]:not([src^="data:"])')).toHaveLength(0);

  await nextFrame();
  await nextFrame();
  const control = probe('control.png');
  await fetch(control);
  await expect.poll(() => probeRequests()).toContain(control);
  expect(probeRequests()).toEqual([control]);
});

test('bookmark links scroll inside the document without changing the URL', async () => {
  const appElementWithTheSameId = document.createElement('p');
  appElementWithTheSameId.id = 'Target';
  document.body.prepend(appElementWithTheSameId);
  const urlBefore = location.href;
  const historyBefore = history.length;
  const root = await showDocx(
    docxBytes({
      body: [
        hyperlink({ anchor: 'Target' }, 'Go to the target'),
        PAGE_BREAK,
        paragraph('Page two'),
        PAGE_BREAK,
        bookmarkedParagraph('Target', 'The target'),
        PAGE_BREAK,
        paragraph('Page four'),
      ].join(''),
    }),
  );
  const target = root.getElementById('Target')!;
  const scroller = host()!;
  const offsetInScroller = (): number =>
    target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  expect(offsetInScroller()).toBeGreaterThan(scroller.clientHeight);

  await userEvent.click(root.querySelector('a')!);
  await expect.poll(offsetInScroller).toBeLessThan(scroller.clientHeight / 2);
  expect(offsetInScroller()).toBeGreaterThanOrEqual(-1);
  expect(location.href).toBe(urlBefore);
  expect(history.length).toBe(historyBefore);
  expect(scroller.scrollTop).toBeGreaterThan(0);
  expect(document.documentElement.scrollTop).toBe(0);
  expect(root.activeElement).toBe(target);
  expect(target.getAttribute('tabindex')).toBe('-1');
});

test('symbol fonts map to Unicode in the rendered document, shown in Arial', async () => {
  const root = await showDocx(
    docxBytes({
      body: [
        symbol('Wingdings', 'F0FC'),
        symbol('Symbol', 'F061'),
        '<w:p><w:r><w:rPr><w:rFonts w:ascii="Symbol"/></w:rPr><w:t>abp</w:t></w:r></w:p>',
        symbol('Wingdings', 'F09A'),
      ].join(''),
    }),
  );
  const spans = (text: string): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>('span[style*="font-family"]')].filter(
      (span) => span.textContent === text,
    );
  for (const text of ['✔', 'α', 'αβπ']) {
    expect(spans(text), text).toHaveLength(1);
    expect(spans(text)[0]!.style.fontFamily, text).toBe('Arial');
  }
  expect(spans('\uF09A')[0]!.style.fontFamily).toBe('Wingdings');
});

test.each(['light', 'dark'] as const)('axe clean (%s)', async (theme) => {
  await showDocx(
    docxBytes({
      body: [
        paragraph('Quarterly report'),
        hyperlink({ id: 'rWeb' }, 'Read more on the web'),
        hyperlink({ anchor: 'Target' }, 'Go to the summary'),
        bookmarkedParagraph('Target', 'Summary'),
      ].join(''),
      relationships: [{ id: 'rWeb', type: 'hyperlink', target: 'https://example.com/', external: true }],
    }),
    { theme },
  );
  const root = document.querySelector('[data-fs-part=docx-viewer]')!;
  expect(root.getAttribute('data-theme')).toBe(theme);
  expect(host()!.getAttribute('aria-label')).toBe('Contents of crafted.docx');
  expect((await axe.run(root)).violations).toEqual([]);
});

test('over maxBytes shows too_large without reading the bytes', async () => {
  const errors: string[] = [];
  await render(
    sized(
      <DocxViewer
        src={new Uint8Array(DOCX_MAX_BYTES + 1)}
        fileName="huge.docx"
        onError={(error) => errors.push(error.kind)}
      />,
    ),
  );
  await expect.poll(() => document.querySelector('[role=alert]')?.textContent).toBe(TOO_LARGE_COPY);
  expect(errors).toEqual(['too_large']);
  expect(host()).toBeNull();
});

test('a file that is not a docx shows load_error', async () => {
  const errors: string[] = [];
  await render(
    sized(
      <DocxViewer
        src={new TextEncoder().encode('not a zip')}
        fileName="broken.docx"
        onError={(error) => errors.push(error.kind)}
      />,
    ),
  );
  await expect.poll(() => document.querySelector('[role=alert]')?.textContent).toBe(LOAD_ERROR_COPY);
  expect(errors).toEqual(['load_error']);
});

test('an OLE compound file (how Word saves a password-protected .docx) shows password_protected', async () => {
  const errors: string[] = [];
  const compoundFile = new Uint8Array(1024);
  compoundFile.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await render(
    sized(
      <DocxViewer src={compoundFile} fileName="locked.docx" onError={(error) => errors.push(error.kind)} />,
    ),
  );
  await expect.poll(() => errors).toEqual(['password_protected']);
});

test('a new source replaces the document, and unmount clears it', async () => {
  const screen = await render(sized(<DocxViewer src={docxBytes({ body: paragraph('First') })} />));
  await expect.poll(shownText).toContain('First');
  const root = shown()!;
  await screen.rerender(sized(<DocxViewer src={docxBytes({ body: paragraph('Second') })} />));
  await expect.poll(shownText).toContain('Second');
  expect(shownText()).not.toContain('First');
  expect(root.querySelectorAll('.docx-wrapper')).toHaveLength(1);
  await screen.unmount();
  expect(root.childNodes).toHaveLength(0);
  expect(root.adoptedStyleSheets).toHaveLength(0);
});

const VML = 'xmlns:v="urn:schemas-microsoft-com:vml"';
const SHADOW_BREAKOUT =
  'position:fixed!important;inset:0!important;z-index:2147483647!important;contain:none!important;background:rgb(1,2,3)!important';

test.each([
  ['@scope (:host)', `X;}@scope/**/(:host)/**/{:scope{${SHADOW_BREAKOUT}}}.y{color:red`],
  ['implicit @scope', `X;}@scope{:scope{${SHADOW_BREAKOUT}}}.y{color:red`],
  ['@scope in @layer', `X;}@layer a{@scope (:host){:scope{${SHADOW_BREAKOUT}}}}.y{color:red`],
  ['@scope in @media', `X;}@media all{@scope{:scope{${SHADOW_BREAKOUT}}}}.y{color:red`],
  ['a fixed link over the page', 'X;}a{position:fixed;inset:0;z-index:2147483647;opacity:0}.y{color:red'],
  [
    'a fixed page wrapper',
    'X;}.docx-wrapper{position:fixed!important;inset:0;z-index:2147483647}.y{color:red',
  ],
])('a document cannot cover the app (%s)', async (_, fontName) => {
  const button = document.createElement('button');
  button.textContent = 'App action';
  button.style.cssText = 'position: absolute; top: 0; left: 0; width: 200px; height: 30px';
  document.body.append(button);
  document.body.style.paddingTop = '60px';
  const vmlRect =
    `<w:p><w:r><w:pict ${VML}><v:rect style="position:fixed;left:0;top:0;width:100vw;height:100vh;` +
    'z-index:2147483647"/></w:pict></w:r></w:p>';
  await showDocx(
    docxBytes({
      body:
        `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>styled</w:t></w:r></w:p>${vmlRect}` +
        hyperlink({ id: 'rWeb' }, 'a link'),
      relationships: [
        { id: 'rStyles', type: 'styles', target: 'styles.xml' },
        { id: 'rWeb', type: 'hyperlink', target: 'https://example.com/', external: true },
      ],
      parts: { 'word/styles.xml': stylesWithFont(fontName) },
    }),
  );
  await nextFrame();
  try {
    expect(host()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(60);
    expect(getComputedStyle(host()!).position).toBe('relative');
    expect(getComputedStyle(host()!).backgroundColor).not.toBe('rgb(1, 2, 3)');
    expect(document.elementFromPoint(100, 15)).toBe(button);
  } finally {
    button.remove();
    document.body.style.paddingTop = '';
  }
});

test('VML text boxes keep their text, and nothing throws once they are shown', async () => {
  const errors: string[] = [];
  const recordError = (event: ErrorEvent): void => void errors.push(event.message);
  window.addEventListener('error', recordError);
  try {
    const root = await showDocx(
      docxBytes({
        body:
          `<w:p><w:r><w:pict ${VML}><v:shape style="width:200pt;height:40pt"><v:textbox><w:txbxContent>` +
          '<w:p><w:r><w:t>Boxed text</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>' +
          `<w:p><w:r><w:pict ${VML}><v:rect style="width:20pt;height:20pt" fillcolor="#336699"/></w:pict></w:r></w:p>`,
      }),
    );
    await nextFrame();
    await nextFrame();
    expect(shownText()).toContain('Boxed text');
    expect(root.querySelectorAll('svg rect')).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    window.removeEventListener('error', recordError);
  }
});

test('a document over the element or relationship limits is refused before it is rendered', async () => {
  const paragraphs = docxBytes({ body: paragraph('x').repeat(50) });
  const signal = new AbortController().signal;
  await expect(
    renderDocx(paragraphs.slice().buffer, signal, { ...DOCX_LIMITS, elements: 40 }),
  ).rejects.toThrow(DocumentLimitExceeded);
  const links = docxBytes({
    body: hyperlink({ id: 'r0' }, 'x').repeat(20),
    relationships: Array.from({ length: 20 }, (_, index) => ({
      id: `r${index}`,
      type: 'hyperlink' as const,
      target: `https://example.com/${index}`,
      external: true,
    })),
  });
  await expect(
    renderDocx(links.slice().buffer, signal, { ...DOCX_LIMITS, relationshipLookups: 300 }),
  ).rejects.toThrow(DocumentLimitExceeded);
  await expect(renderDocx(links.slice().buffer, signal)).resolves.toHaveProperty('nodes');
});

const appDigitsWidth = (): number => {
  const digits = document.createElement('span');
  digits.style.font = '20px Arial';
  digits.textContent = '0123456789';
  document.body.append(digits);
  const width = digits.getBoundingClientRect().width;
  digits.remove();
  return width;
};

test("a document's @font-face cannot change the app's fonts, while shown or after", async () => {
  const before = appDigitsWidth();
  const screen = await render(
    sized(
      <DocxViewer
        src={docxBytes({
          body: '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>0123456789</w:t></w:r></w:p>',
          relationships: [{ id: 'rStyles', type: 'styles', target: 'styles.xml' }],
          parts: {
            'word/styles.xml': stylesWithFont(
              'Arial;}@font-face{font-family:Arial;src:local(Menlo),local(Courier);unicode-range:U+30-39}.y{color:red',
            ),
          },
        })}
      />,
    ),
  );
  await expect.poll(shownText).toContain('0123456789');
  await document.fonts.ready;
  await nextFrame();
  expect(appDigitsWidth()).toBe(before);
  await screen.unmount();
  await nextFrame();
  expect(appDigitsWidth()).toBe(before);
  expect([...document.fonts].map((face) => face.family.replace(/"/g, ''))).not.toContain('Arial');
});

test("docx-preview's embedded-font CSS is scoped too, with the runs that use the font", async () => {
  const root = await showDocx(
    docxBytes({
      body: '<w:p><w:r><w:rPr><w:rFonts w:ascii="Probe Sans"/></w:rPr><w:t>embedded</w:t></w:r></w:p>',
      relationships: [{ id: 'rFonts', type: 'fontTable', target: 'fontTable.xml' }],
      parts: { 'word/fontTable.xml': FONT_TABLE, 'word/fonts/font1.odttf': new Uint8Array(64).fill(3) },
      partRelationships: {
        'word/fontTable.xml': [{ id: 'rFont', type: 'font', target: 'fonts/font1.odttf' }],
      },
    }),
  );
  const faces = styleText(root).match(/@font-face \{ font-family: [^;]+/g) ?? [];
  expect(faces).toHaveLength(1);
  expect(faces[0]).toMatch(/fs-docx-\d+-Probe Sans/);
  const run = [...root.querySelectorAll<HTMLElement>('span')].find(
    (span) => span.textContent === 'embedded',
  )!;
  expect(run.style.fontFamily).toMatch(/^"?fs-docx-\d+-Probe Sans"?$/);
});
