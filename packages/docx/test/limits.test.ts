import { strToU8, unzipSync, UnzipInflate, zipSync } from 'fflate';
import { afterEach, expect, test, vi } from 'vitest';
import { DOCX_LIMITS, DocumentLimitExceeded, repackWithinLimits } from '../src/limits';

const MEBIBYTE = 1024 * 1024;
const SMALL = { ...DOCX_LIMITS, inflatedBytes: MEBIBYTE, markupBytes: MEBIBYTE, entries: 10 };

afterEach(() => vi.restoreAllMocks());

const unzipped = async ({ archive: blob }: { archive: Blob }): Promise<Record<string, Uint8Array>> =>
  unzipSync(new Uint8Array(await blob.arrayBuffer()));

function compressedBytesInflatedWhile(run: () => void): number {
  let pushed = 0;
  const push = UnzipInflate.prototype.push;
  vi.spyOn(UnzipInflate.prototype, 'push').mockImplementation(function (this: UnzipInflate, data, final) {
    pushed += data.length;
    return push.call(this, data, final);
  });
  run();
  return pushed;
}

function withDeclaredSizesOf(zip: Uint8Array, declaredSize: number): Uint8Array {
  const lying = zip.slice();
  const view = new DataView(lying.buffer);
  for (let offset = 0; offset < lying.length - 4; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, declaredSize, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, declaredSize, true);
  }
  return lying;
}

test('a docx within the limits is repacked with the same entries and bytes, stored', async () => {
  const files = {
    'word/document.xml': strToU8('<w:document/>'.repeat(1000)),
    'word/media/a.png': new Uint8Array(3000).fill(7),
  };
  const repacked = repackWithinLimits(zipSync(files));
  expect(await unzipped(repacked)).toEqual(files);
  expect(repacked.archive.size).toBeGreaterThan(16_000);
  expect(repacked.fileSizes).toEqual(
    new Map([
      ['word/document.xml', 13_000],
      ['word/media/a.png', 3000],
    ]),
  );
});

test('a zip bomb stops at the inflated-bytes limit, after inflating little of it', () => {
  const bomb = zipSync({ 'word/media/bomb.bin': new Uint8Array(64 * MEBIBYTE) });
  const pushed = compressedBytesInflatedWhile(() =>
    expect(() => repackWithinLimits(bomb, SMALL)).toThrow(DocumentLimitExceeded),
  );
  expect(pushed).toBeLessThan(bomb.length / 2);
});

test('XML has its own, smaller cap, recognized by content whatever the file is called', () => {
  const half = strToU8('<w:p/>'.repeat(MEBIBYTE / 6 / 2 + 1000));
  const limits = { ...SMALL, inflatedBytes: 4 * MEBIBYTE };
  expect(repackWithinLimits(zipSync({ 'word/a.xml': half }), limits).archive).toBeInstanceOf(Blob);
  expect(() =>
    repackWithinLimits(zipSync({ 'word/a.xml': half, 'word/_rels/a.xml.rels': half }), limits),
  ).toThrow(DocumentLimitExceeded);
  expect(() => repackWithinLimits(zipSync({ 'a.bin': half, 'b.png': half }), limits)).toThrow(
    DocumentLimitExceeded,
  );
  const binary = new Uint8Array(half.length).fill(7);
  expect(repackWithinLimits(zipSync({ 'a.xml': binary, 'b.xml': binary }), limits).archive).toBeInstanceOf(
    Blob,
  );
});

test('sizes declared in the headers are not trusted', () => {
  const bomb = withDeclaredSizesOf(zipSync({ 'word/media/a.bin': new Uint8Array(8 * MEBIBYTE) }), 10);
  expect(() => repackWithinLimits(bomb, SMALL)).toThrow(DocumentLimitExceeded);
});

test('too many entries is refused, counting entries that repeat a name', () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index}.xml`, strToU8('x')]));
  expect(() => repackWithinLimits(zipSync(files), SMALL)).toThrow(DocumentLimitExceeded);

  const once = zipSync({ 'same.xml': strToU8('x') });
  const entry = once.subarray(0, once.length - 22 - 46 - 8);
  const repeated = new Uint8Array(entry.length * 12);
  for (let copy = 0; copy < 12; copy++) repeated.set(entry, copy * entry.length);
  expect(() => repackWithinLimits(repeated, SMALL)).toThrow(DocumentLimitExceeded);
});

const numbering = (levels: number, lists: number): Uint8Array =>
  strToU8(
    `<w:numbering><w:abstractNum w:abstractNumId="0">${'<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>'.repeat(levels)}` +
      `</w:abstractNum>${'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'.repeat(lists)}</w:numbering>`,
  );

test('numbering whose lists times levels docx-preview would multiply out is refused before it is parsed', () => {
  expect(repackWithinLimits(zipSync({ 'word/numbering.xml': numbering(500, 500) })).archive).toBeInstanceOf(
    Blob,
  );
  expect(() => repackWithinLimits(zipSync({ 'word/numbering.xml': numbering(1500, 1500) }))).toThrow(
    /numbering levels/,
  );
  expect(() =>
    repackWithinLimits(zipSync({ 'word/media/n.png': numbering(30, 30) }), {
      ...DOCX_LIMITS,
      numberingLevels: 3000,
    }),
  ).toThrow(DocumentLimitExceeded);
});

test('numbering tags split across inflated chunks are counted once each', () => {
  const lists = 4000;
  const archive = zipSync({ 'n.xml': numbering(1, lists) }, { level: 0 });
  const openingAndClosingTags = 2 * lists * (2 * 1);
  const limits = { ...DOCX_LIMITS, numberingLevels: openingAndClosingTags };
  expect(repackWithinLimits(archive, limits)).toHaveProperty('archive');
  expect(() =>
    repackWithinLimits(archive, { ...limits, numberingLevels: openingAndClosingTags - 1 }),
  ).toThrow(DocumentLimitExceeded);
});

const BILLION_LAUGHS =
  '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">' +
  Array.from({ length: 9 }, (_, level) => {
    const previous = level === 0 ? 'lol' : `lol${level}`;
    return `<!ENTITY lol${level + 1} "${`&${previous};`.repeat(10)}">`;
  }).join('') +
  ']><w:document><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>';

test('a part that declares a document type is refused as unopenable, not as too large', () => {
  const refuse = (): unknown => repackWithinLimits(zipSync({ 'word/document.xml': strToU8(BILLION_LAUGHS) }));
  expect(refuse).toThrow(/declares a document type/);
  expect(refuse).not.toThrow(DocumentLimitExceeded);
});

test('a document type declaration split across inflated chunks is still found', () => {
  const dataStart = 30 + 'word/document.xml'.length;
  const padding = ' '.repeat(16 * 1024 - dataStart - '<a>'.length - 4);
  const archive = zipSync({ 'word/document.xml': strToU8(`<a>${padding}<!DOCTYPE a []><a/>`) }, { level: 0 });
  expect(() => repackWithinLimits(archive)).toThrow(/declares a document type/);
  const binary = zipSync({ 'word/media/a.bin': strToU8(`\u0001${padding}<!DOCTYPE a []>`) }, { level: 0 });
  expect(repackWithinLimits(binary)).toHaveProperty('archive');
});

const repackPart = (name: string, text: string): unknown =>
  repackWithinLimits(zipSync({ [name]: strToU8(text) }));

test('a part may start with the plain HTML doctype (Ruling P4-14), in any case and spacing', () => {
  for (const start of ['<!DOCTYPE html>', '<!doctype HTML>', '\n  <!DocType \t html \n >']) {
    expect(repackPart('word/afchunk.htm', `${start}<html><body><p>chunk</p></body></html>`)).toHaveProperty(
      'archive',
    );
  }
});

test.each([
  ['an internal subset', '<!DOCTYPE html [<!ENTITY a "b">]><html>&a;</html>'],
  ['a system identifier', '<!DOCTYPE html SYSTEM "x"><html></html>'],
  ['a public identifier', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x"><html></html>'],
  ['a second declaration after the plain one', '<!DOCTYPE html><!DOCTYPE x [<!ENTITY a "b">]><x/>'],
  ['a plain HTML doctype that is not at the start', '<html><!DOCTYPE html></html>'],
  ['any other document type', '<!doctype w:document [<!ENTITY a "b">]><w:document/>'],
])('every other document type declaration is still refused: %s', (_, text) => {
  expect(() => repackPart('word/afchunk.htm', text)).toThrow(/declares a document type/);
});

test('a document type split across chunks after an allowed start is still found', () => {
  const dataStart = 30 + 'word/afchunk.htm'.length;
  const allowed = '<!DOCTYPE html>';
  const padding = ' '.repeat(16 * 1024 - dataStart - allowed.length - 4);
  const archive = zipSync(
    { 'word/afchunk.htm': strToU8(`${allowed}${padding}<!DOCTYPE a []>`) },
    { level: 0 },
  );
  expect(() => repackWithinLimits(archive)).toThrow(/declares a document type/);
});
