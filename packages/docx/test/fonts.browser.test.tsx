import { startTransition, useLayoutEffect, useState } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import DocxDocument from '../src/DocxDocument';
import { showFontFaces, type FontScope } from '../src/fontScope';
import type * as RenderDocx from '../src/renderDocx';
import { renderDocx, showRendered, type RenderedDocx } from '../src/renderDocx';
import { docxBytes, FONT_TABLE } from './fixtures/docx';

vi.mock('../src/renderDocx', async (importOriginal) => {
  const original = await importOriginal<typeof RenderDocx>();
  return {
    ...original,
    renderDocx: vi.fn(original.renderDocx),
    showRendered: vi.fn(original.showRendered),
  };
});

const embeddedFontBuffer = (): ArrayBuffer =>
  docxBytes({
    body: '<w:p><w:r><w:rPr><w:rFonts w:ascii="Probe Sans"/></w:rPr><w:t>embedded</w:t></w:r></w:p>',
    relationships: [{ id: 'rFonts', type: 'fontTable', target: 'fontTable.xml' }],
    parts: { 'word/fontTable.xml': FONT_TABLE, 'word/fonts/font1.odttf': new Uint8Array(64).fill(3) },
    partRelationships: {
      'word/fontTable.xml': [{ id: 'rFont', type: 'font', target: 'fonts/font1.odttf' }],
    },
  }).slice().buffer;

const scopedFacesInTheDocument = (): string[] =>
  [...document.fonts].map((face) => face.family).filter((family) => family.includes('fs-docx-'));

async function renderedForReal(): Promise<RenderedDocx> {
  const actual = await vi.importActual<typeof RenderDocx>('../src/renderDocx');
  return actual.renderDocx(embeddedFontBuffer(), new AbortController().signal);
}

test('a render that finishes while the viewer is being removed leaves no faces in document.fonts', async () => {
  const rendered = await renderedForReal();
  let finishRender = (): void => {};
  vi.mocked(renderDocx).mockReturnValueOnce(
    new Promise((resolve) => (finishRender = () => resolve(rendered))),
  );
  const FinishRenderOnRemoval = (): null => {
    useLayoutEffect(() => () => finishRender(), []);
    return null;
  };
  let removeViewer = (): void => {};
  const Viewer = (): React.JSX.Element | null => {
    const [shown, setShown] = useState(true);
    removeViewer = () => startTransition(() => setShown(false));
    if (!shown) return null;
    return (
      <>
        <DocxDocument data={new ArrayBuffer(8)} name="x.docx" classNames={undefined} onError={() => {}} />
        <FinishRenderOnRemoval />
      </>
    );
  };
  await render(<Viewer />);
  const signal = vi.mocked(renderDocx).mock.calls.at(-1)![1];

  removeViewer();
  await expect.poll(() => signal.aborted).toBe(true);
  expect(vi.mocked(showRendered).mock.calls.some(([, shown]) => shown === rendered)).toBe(true);
  expect(scopedFacesInTheDocument()).toEqual([]);
});

test('a failure while mounting a rendered document is reported, and the viewer is no longer busy', async () => {
  const onError = vi.fn();
  vi.mocked(showRendered).mockImplementationOnce(() => {
    throw new Error('mount failed');
  });
  const screen = await render(
    <DocxDocument data={embeddedFontBuffer()} name="x.docx" classNames={undefined} onError={onError} />,
  );
  await expect.poll(() => onError.mock.calls.length).toBe(1);
  expect(onError.mock.calls[0]![0]).toMatchObject({ kind: 'load_error' });
  await expect
    .element(screen.getByRole('region', { name: 'Contents of x.docx' }))
    .not.toHaveAttribute('aria-busy');
});

test('replacing a shown document deletes its faces from document.fonts', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const first = await renderedForReal();
  const second = await renderedForReal();
  const facesOf = ({ styles }: RenderedDocx): string[] =>
    scopedFacesInTheDocument().filter((family) => family.includes(styles.fonts.prefix));
  showRendered(shadowRoot, first);
  expect(facesOf(first)).toHaveLength(1);
  showRendered(shadowRoot, second);
  expect([facesOf(first), facesOf(second)].map((faces) => faces.length)).toEqual([0, 1]);
  showRendered(shadowRoot, null);
  host.remove();
});

test('each render scopes its faces under a counter and a random part, so a document cannot guess a name', async () => {
  const first = await renderedForReal();
  const second = await renderedForReal();
  const scopedName = /^fs-docx-\d+-[0-9a-z]+-$/;
  expect(first.styles.fonts.prefix).toMatch(scopedName);
  expect(second.styles.fonts.prefix).toMatch(scopedName);
  const randomPart = (prefix: string): string => prefix.split('-')[3]!;
  expect(randomPart(first.styles.fonts.prefix)).not.toBe(randomPart(second.styles.fonts.prefix));
});

test('a face the FontFace constructor refuses is skipped; the others still load', () => {
  const RealFontFace = FontFace;
  vi.stubGlobal(
    'FontFace',
    class extends RealFontFace {
      constructor(family: string, source: string, descriptors?: FontFaceDescriptors) {
        if (family.includes('Refused')) throw new SyntaxError('refused');
        super(family, source, descriptors);
      }
    },
  );
  const scope: FontScope = {
    prefix: 'fs-docx-t-x-',
    families: new Map(),
    faces: [
      { family: 'fs-docx-t-x-Refused', source: 'local(Menlo)', descriptors: {} },
      { family: 'fs-docx-t-x-Kept', source: 'local(Menlo)', descriptors: {} },
    ],
  };
  try {
    const shown = showFontFaces(scope);
    expect(shown.map((face) => face.family.replace(/"/g, ''))).toEqual(['fs-docx-t-x-Kept']);
    for (const face of shown) document.fonts.delete(face);
  } finally {
    vi.unstubAllGlobals();
  }
});
