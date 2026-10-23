import { expect, test } from 'vitest';
import { DOCX_LIMITS, DocumentLimitExceeded } from '../src/limits';
import { assertRenderWithinLimits, type ParsedDocx } from '../src/renderedWork';

type Node = { type: string; children?: Node[] } & Record<string, unknown>;

const node = (type: string, children: Node[] = [], fields: Record<string, unknown> = {}): Node => ({
  type,
  children,
  ...fields,
});
const times = (count: number, make: () => Node): Node[] => Array.from({ length: count }, make);
const paragraphs = (count: number): Node[] => times(count, () => node('paragraph', [node('run')]));
const pageBreak = (): Node => node('paragraph', [node('run', [node('break', [], { break: 'page' })])]);
const relationships = (count: number): { id: string; target: string }[] =>
  Array.from({ length: count }, (_, id) => ({ id: `r${id}`, target: `media/${id}.png` }));

const documentOf = (body: Node[], parts: ParsedDocx['parts'] = []): ParsedDocx => {
  const documentPart = { path: 'word/document.xml', rels: [], body: node('body', body) };
  return { documentPart, parts: [documentPart, ...parts] };
};

function countedTypeReads(nodes: Node[]): { parsed: ParsedDocx; reads: () => number } {
  let reads = 0;
  const counted = nodes.map(
    (child) =>
      new Proxy(child, {
        get: (target, key) => {
          if (key === 'type') reads++;
          return Reflect.get(target, key) as unknown;
        },
      }),
  );
  return { parsed: documentOf(counted), reads: () => reads };
}

test('the parsed document is refused past the element cap, after counting no more than the cap', () => {
  const { parsed, reads } = countedTypeReads(times(1_000_000, () => node('paragraph')));
  expect(() => assertRenderWithinLimits(parsed, new Map(), { ...DOCX_LIMITS, elements: 1000 })).toThrow(
    DocumentLimitExceeded,
  );
  expect(reads()).toBeLessThanOrEqual(1000);
});

test('relationships are capped, and so are hyperlinks and images times relationships', () => {
  const limits = { ...DOCX_LIMITS, relationships: 100, relationshipLookups: 1000 };
  const tooMany: ParsedDocx = { rels: relationships(50), parts: [{ rels: relationships(51) }] };
  expect(() => assertRenderWithinLimits(tooMany, new Map(), limits)).toThrow(DocumentLimitExceeded);

  const lookups = (count: number): ParsedDocx => {
    const parsed = documentOf([
      node(
        'paragraph',
        times(count, () => node('hyperlink')),
      ),
    ]);
    parsed.documentPart!.rels = relationships(100);
    return parsed;
  };
  expect(() => assertRenderWithinLimits(lookups(10), new Map(), limits)).not.toThrow();
  expect(() => assertRenderWithinLimits(lookups(11), new Map(), limits)).toThrow(DocumentLimitExceeded);
});

test('a header is counted once per page: page breaks, section breaks and page-breaking paragraphs, plus one', () => {
  const header = { path: 'word/header1.xml', rootElement: node('header', paragraphs(99)) };
  const pages = [
    pageBreak(),
    node('paragraph', [], { sectionProps: {} }),
    node('paragraph', [], { pageBreakBefore: true }),
    node('paragraph', [], { styleName: 'Chapter' }),
  ];
  const parsed = documentOf(pages, [header]);
  parsed.stylesPart = { styles: [{ id: 'Chapter', paragraphProps: { pageBreakBefore: true } }] };
  const headerElements = 1 + 99 * 2;
  const bodyElements = 1 + 3 + 3;
  const exactly = { ...DOCX_LIMITS, elements: bodyElements + 5 * headerElements };
  expect(() => assertRenderWithinLimits(parsed, new Map(), exactly)).not.toThrow();
  expect(() =>
    assertRenderWithinLimits(parsed, new Map(), { ...exactly, elements: exactly.elements - 1 }),
  ).toThrow(/rendered elements/);
});

test('the reviewer case: a 1,000-paragraph header on 1,000 pages is refused', () => {
  const header = { path: 'word/header1.xml', rootElement: node('header', paragraphs(1000)) };
  expect(() => assertRenderWithinLimits(documentOf(times(999, pageBreak), [header]), new Map())).toThrow(
    /rendered elements/,
  );
});

test('a footnote is counted once per reference, so 1,000 references to a 1,000-paragraph note are refused', () => {
  const footnoteDocument = (paragraphCount: number, references: number): ParsedDocx => {
    const parsed = documentOf([
      node(
        'paragraph',
        times(references, () => node('footnoteReference', [], { id: '1' })),
      ),
    ]);
    const note = node('footnote', paragraphs(paragraphCount), { id: '1' });
    parsed.footnotesPart = { path: 'word/footnotes.xml', notes: [note] };
    parsed.parts.push(parsed.footnotesPart);
    return parsed;
  };
  expect(() => assertRenderWithinLimits(footnoteDocument(10, 100), new Map())).not.toThrow();
  expect(() => assertRenderWithinLimits(footnoteDocument(1000, 1000), new Map())).toThrow(
    /rendered elements/,
  );
});

test('images are counted as data: URLs once per place they are shown, with picture bullets', () => {
  const imageDocument = (references: number): ParsedDocx => {
    const parsed = documentOf(times(references, () => node('paragraph', [node('image', [], { src: 'rI' })])));
    parsed.documentPart!.rels = [{ id: 'rI', target: 'media/a.png' }];
    return parsed;
  };
  const fourMebibytes = new Map([['word/media/a.png', 4 * 1024 * 1024]]);
  expect(() => assertRenderWithinLimits(imageDocument(10), fourMebibytes)).not.toThrow();
  expect(() => assertRenderWithinLimits(imageDocument(40), fourMebibytes)).toThrow(/bytes of images/);

  const bullets = imageDocument(0);
  bullets.numberingPart = {
    path: 'word/numbering.xml',
    rels: [{ id: 'rB', target: '/word/media/a.png' }],
    domNumberings: Array.from({ length: 40 }, () => ({ bullet: { src: 'rB' } })),
  };
  expect(() => assertRenderWithinLimits(bullets, fourMebibytes)).toThrow(/bytes of images/);
});
