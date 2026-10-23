/**
 * A minimal PDF writer for tests: pages of any size, optional Helvetica text, link annotations to a URI or
 * to another page, and the Standard security handler (RC4, 40-bit, revision 2) for a password-protected
 * file. Everything is generated here, so no third-party fixture is checked in.
 *
 * @example
 * ```ts
 * const bytes = pdfBytes({ pages: [{ text: 'Hello' }, { width: 792, height: 612 }] });
 * ```
 */
export interface FixturePage {
  width?: number;
  height?: number;
  text?: string;
  links?: FixtureLink[];
  unreadable?: boolean;
}

/**
 * A link annotation: `uri` makes a URI action, `toPage` (0-based) a GoTo action with an explicit destination,
 * `named` a named action such as `NextPage`.
 *
 * @example
 * ```ts
 * const link: FixtureLink = { rect: [72, 600, 300, 640], uri: 'https://example.com/' };
 * ```
 */
export type FixtureLink = { rect: [number, number, number, number] } & (
  { uri: string } | { toPage: number } | { named: 'FirstPage' | 'PrevPage' | 'NextPage' | 'LastPage' }
);

/**
 * What `pdfBytes` writes: the pages, and `password` to encrypt the file with that user password.
 *
 * @example
 * ```ts
 * const fixture: PdfFixture = { pages: [{ text: 'Secret' }], password: 'open sesame' };
 * ```
 */
export interface PdfFixture {
  pages: FixturePage[];
  password?: string;
}

const LETTER = { width: 612, height: 792 };
const FIRST_PAGE_OBJECT = 4;
const FILE_ID = '0123456789abcdef0123456789abcdef';
const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e,
  0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const ALL_PERMISSIONS = -4;

const latin1 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32),
);

function md5Round(index: number, b: number, c: number, d: number): { mixed: number; word: number } {
  const round = index >> 4;
  if (round === 0) return { mixed: (b & c) | (~b & d), word: index };
  if (round === 1) return { mixed: (d & b) | (~d & c), word: (5 * index + 1) % 16 };
  if (round === 2) return { mixed: b ^ c ^ d, word: (3 * index + 5) % 16 };
  return { mixed: c ^ (b | ~d), word: (7 * index) % 16 };
}

function md5(input: Uint8Array): Uint8Array {
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;
  const words = new DataView(message.buffer);
  words.setUint32(paddedLength - 8, (input.length * 8) >>> 0, true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let block = 0; block < paddedLength; block += 64) {
    let [a, b, c, d] = state as [number, number, number, number];
    for (let index = 0; index < 64; index++) {
      const { mixed, word } = md5Round(index, b, c, d);
      const sum = (a + mixed + MD5_CONSTANTS[index]! + words.getUint32(block + word * 4, true)) | 0;
      const shift = MD5_SHIFTS[(index >> 4) * 4 + (index % 4)]!;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }
    [a, b, c, d].forEach((value, index) => (state[index] = (state[index]! + value) | 0));
  }
  const digest = new DataView(new ArrayBuffer(16));
  state.forEach((value, index) => digest.setUint32(index * 4, value, true));
  return new Uint8Array(digest.buffer);
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const box = Array.from({ length: 256 }, (_, index) => index);
  for (let index = 0, swap = 0; index < 256; index++) {
    swap = (swap + box[index]! + key[index % key.length]!) & 255;
    [box[index], box[swap]] = [box[swap]!, box[index]!];
  }
  const output = new Uint8Array(data.length);
  for (let position = 0, index = 0, swap = 0; position < data.length; position++) {
    index = (index + 1) & 255;
    swap = (swap + box[index]!) & 255;
    [box[index], box[swap]] = [box[swap]!, box[index]!];
    output[position] = data[position]! ^ box[(box[index]! + box[swap]!) & 255]!;
  }
  return output;
}

const paddedPassword = (password: string): Uint8Array =>
  concat(latin1(password), PASSWORD_PADDING).slice(0, 32);

interface Encryption {
  dictionary: string;
  objectKey: (objectNumber: number) => Uint8Array;
}

function standardEncryption(userPassword: string, ownerPassword: string): Encryption {
  const owner = rc4(md5(paddedPassword(ownerPassword)).slice(0, 5), paddedPassword(userPassword));
  const permissions = new Uint8Array(new Int32Array([ALL_PERMISSIONS]).buffer);
  const fileKey = md5(
    concat(
      paddedPassword(userPassword),
      owner,
      permissions,
      Uint8Array.from(FILE_ID.match(/../g)!, (pair) => parseInt(pair, 16)),
    ),
  ).slice(0, 5);
  const user = rc4(fileKey, PASSWORD_PADDING);
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${hex(owner)}> /U <${hex(user)}> /P ${ALL_PERMISSIONS} >>`,
    objectKey: (objectNumber) =>
      md5(
        concat(
          fileKey,
          Uint8Array.of(objectNumber & 255, (objectNumber >> 8) & 255, objectNumber >> 16, 0, 0),
        ),
      ).slice(0, 10),
  };
}

const escapePdfString = (text: string): string => text.replace(/[\\()]/g, (character) => `\\${character}`);

function annotation(link: FixtureLink, pageObjectNumbers: number[]): string {
  const action =
    'uri' in link
      ? `/A << /S /URI /URI (${escapePdfString(link.uri)}) >>`
      : 'named' in link
        ? `/A << /S /Named /N /${link.named} >>`
        : `/A << /S /GoTo /D [${pageObjectNumbers[link.toPage]} 0 R /Fit] >>`;
  return `<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(' ')}] /Border [0 0 0] ${action} >>`;
}

interface PdfObject {
  number: number;
  body: string;
  stream?: Uint8Array;
}

function pageObjects(pages: FixturePage[]): PdfObject[] {
  const pageNumbers = pages.map((_, index) => FIRST_PAGE_OBJECT + index);
  let nextObject = FIRST_PAGE_OBJECT + pages.length;
  const objects: PdfObject[] = [];
  pages.forEach((page, index) => {
    const { width, height } = { ...LETTER, ...page };
    const contentsNumber = page.text === undefined ? undefined : nextObject++;
    const annotations = page.links?.map((link) => annotation(link, pageNumbers)).join(' ');
    if (page.unreadable) {
      objects.push({ number: pageNumbers[index]!, body: '42' });
      return;
    }
    objects.push({
      number: pageNumbers[index]!,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >>` +
        (contentsNumber === undefined ? '' : ` /Contents ${contentsNumber} 0 R`) +
        (annotations ? ` /Annots [${annotations}]` : '') +
        ' >>',
    });
    if (contentsNumber !== undefined) {
      const content = `BT /F1 24 Tf 72 ${height - 96} Td (${escapePdfString(page.text!)}) Tj ET`;
      objects.push({ number: contentsNumber, body: '', stream: latin1(content) });
    }
  });
  return objects;
}

function serialized(object: PdfObject, encryption: Encryption | undefined): Uint8Array {
  if (!object.stream) return latin1(`${object.number} 0 obj\n${object.body}\nendobj\n`);
  const data = encryption ? rc4(encryption.objectKey(object.number), object.stream) : object.stream;
  return concat(
    latin1(`${object.number} 0 obj\n<< /Length ${data.length} >>\nstream\n`),
    data,
    latin1('\nendstream\nendobj\n'),
  );
}

/**
 * Writes a PDF with `fixture.pages`; with `fixture.password`, the file is encrypted (owner password
 * `owner`) and opens only with that user password.
 *
 * @example
 * ```ts
 * const thousandPages = pdfBytes({ pages: Array.from({ length: 1000 }, () => ({})) });
 * ```
 */
export function pdfBytes(fixture: PdfFixture): Uint8Array<ArrayBuffer> {
  const encryption =
    fixture.password === undefined ? undefined : standardEncryption(fixture.password, 'owner');
  const pageReferences = fixture.pages.map((_, index) => `${FIRST_PAGE_OBJECT + index} 0 R`).join(' ');
  const objects: PdfObject[] = [
    { number: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { number: 2, body: `<< /Type /Pages /Kids [${pageReferences}] /Count ${fixture.pages.length} >>` },
    { number: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ...pageObjects(fixture.pages),
  ];
  const encryptNumber = objects.length + 1;
  if (encryption) objects.push({ number: encryptNumber, body: encryption.dictionary });
  objects.sort((first, second) => first.number - second.number);
  const chunks: Uint8Array[] = [latin1('%PDF-1.4\n')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  for (const object of objects) {
    offsets.push(length);
    const chunk = serialized(object, object.number === encryptNumber ? undefined : encryption);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xref = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const trailerExtras = encryption ? ` /Encrypt ${encryptNumber} 0 R /ID [<${FILE_ID}> <${FILE_ID}>]` : '';
  chunks.push(
    latin1(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtras} >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return concat(...chunks);
}

/**
 * `count` letter-size pages without content, for documents whose size, not content, is under test.
 *
 * @example
 * ```ts
 * pdfBytes({ pages: blankPages(10_000) });
 * ```
 */
export const blankPages = (count: number): FixturePage[] => Array.from({ length: count }, () => ({}));
