export interface TiffFixturePage {
  width: number;
  height: number;
  rgb?: readonly [number, number, number];
  claimsSizeWithoutPixels?: boolean;
}

export interface TiffFixtureOptions {
  rowsPerStrip?: number;
  compression?: 'none' | 'lzw' | 'packbits';
}

const HEADER_BYTES = 8;
const IFD_ENTRY_BYTES = 12;
const SHORT = 3;
const LONG = 4;
const COMPRESSION_CODES = { none: 1, lzw: 5, deflate: 8, packbits: 32773 } as const;

interface IfdEntry {
  tag: number;
  type: typeof SHORT | typeof LONG;
  values: number[];
}

const evenLength = (length: number): number => length + (length % 2);

function rawStrips(page: TiffFixturePage, rowsPerStrip: number): Uint8Array[] {
  if (page.claimsSizeWithoutPixels) return [new Uint8Array(3)];
  const [red, green, blue] = page.rgb ?? [200, 40, 40];
  const strips: Uint8Array[] = [];
  for (let row = 0; row < page.height; row += rowsPerStrip) {
    const strip = new Uint8Array(Math.min(rowsPerStrip, page.height - row) * page.width * 3);
    for (let offset = 0; offset < strip.length; offset += 3) strip.set([red, green, blue], offset);
    strips.push(strip);
  }
  return strips;
}

/**
 * Encodes bytes as TIFF LZW (9 to 12 bit codes, most significant bit first, early code-width change).
 *
 * @example
 * ```ts
 * const stored = lzwEncode(new Uint8Array([1, 1, 1, 1]));
 * ```
 */
export function lzwEncode(input: Uint8Array): Uint8Array {
  const codes: Array<[code: number, bits: number]> = [];
  let dictionary = new Map<string, number>();
  let nextCode = 258;
  let bits = 9;
  const reset = (): void => {
    dictionary = new Map(Array.from({ length: 256 }, (_, byte) => [String(byte), byte]));
    nextCode = 258;
    bits = 9;
  };
  reset();
  codes.push([256, bits]);
  let current = '';
  for (const byte of input) {
    const extended = current === '' ? String(byte) : `${current},${byte}`;
    if (dictionary.has(extended)) {
      current = extended;
      continue;
    }
    codes.push([dictionary.get(current)!, bits]);
    dictionary.set(extended, nextCode++);
    if (nextCode === 1 << bits && bits < 12) bits++;
    if (nextCode === 4093) {
      codes.push([256, bits]);
      reset();
    }
    current = String(byte);
  }
  if (current !== '') codes.push([dictionary.get(current)!, bits]);
  codes.push([257, bits]);
  return packCodes(codes);
}

function packCodes(codes: Array<[code: number, bits: number]>): Uint8Array {
  const output = new Uint8Array(Math.ceil(codes.reduce((total, [, bits]) => total + bits, 0) / 8) + 1);
  let bitPosition = 0;
  for (const [code, bits] of codes) {
    for (let bit = bits - 1; bit >= 0; bit--, bitPosition++) {
      if ((code >> bit) & 1) output[bitPosition >> 3]! |= 0x80 >> (bitPosition & 7);
    }
  }
  return output;
}

/**
 * Encodes bytes as PackBits, as runs of up to 128 repeated bytes.
 *
 * @example
 * ```ts
 * const stored = packBitsEncode(new Uint8Array(300));
 * ```
 */
export function packBitsEncode(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let at = 0; at < input.length;) {
    let run = 1;
    while (run < 128 && input[at + run] === input[at]) run++;
    output.push(257 - run, input[at]!);
    at += run;
  }
  return new Uint8Array(output);
}

interface PlannedPage {
  page: TiffFixturePage;
  compression: number;
  rowsPerStrip: number;
  strips: Uint8Array[];
}

function entriesOf(planned: PlannedPage, stripOffsets: number[]): IfdEntry[] {
  const { page, compression, rowsPerStrip, strips } = planned;
  return [
    { tag: 256, type: LONG, values: [page.width] },
    { tag: 257, type: LONG, values: [page.height] },
    { tag: 258, type: SHORT, values: [8, 8, 8] },
    { tag: 259, type: SHORT, values: [compression] },
    { tag: 262, type: SHORT, values: [2] },
    { tag: 273, type: LONG, values: stripOffsets },
    { tag: 277, type: SHORT, values: [3] },
    { tag: 278, type: LONG, values: [rowsPerStrip] },
    { tag: 279, type: LONG, values: strips.map((strip) => strip.length) },
  ];
}

const valueBytes = (entry: IfdEntry): number => entry.values.length * (entry.type === SHORT ? 2 : 4);
const outOfLineBytes = (entries: IfdEntry[]): number =>
  evenLength(
    entries.filter((entry) => valueBytes(entry) > 4).reduce((total, entry) => total + valueBytes(entry), 0),
  );

function writeValues(view: DataView, at: number, entry: IfdEntry): void {
  entry.values.forEach((value, index) => {
    if (entry.type === SHORT) view.setUint16(at + index * 2, value, true);
    else view.setUint32(at + index * 4, value, true);
  });
}

function pageBytes(planned: PlannedPage): number {
  const entries = entriesOf(
    planned,
    planned.strips.map(() => 0),
  );
  const stripBytes = planned.strips.reduce((total, strip) => total + evenLength(strip.length), 0);
  return stripBytes + outOfLineBytes(entries) + 2 + entries.length * IFD_ENTRY_BYTES + 4;
}

function writePage(view: DataView, planned: PlannedPage, pageAt: number, nextIfdAt: number): number {
  const stripOffsets: number[] = [];
  let cursor = pageAt;
  for (const strip of planned.strips) {
    stripOffsets.push(cursor);
    new Uint8Array(view.buffer).set(strip, cursor);
    cursor += evenLength(strip.length);
  }
  const entries = entriesOf(planned, stripOffsets);
  const ifdAt = cursor + outOfLineBytes(entries);
  view.setUint16(ifdAt, entries.length, true);
  entries.forEach((entry, index) => {
    const entryAt = ifdAt + 2 + index * IFD_ENTRY_BYTES;
    view.setUint16(entryAt, entry.tag, true);
    view.setUint16(entryAt + 2, entry.type, true);
    view.setUint32(entryAt + 4, entry.values.length, true);
    if (valueBytes(entry) <= 4) return writeValues(view, entryAt + 8, entry);
    view.setUint32(entryAt + 8, cursor, true);
    writeValues(view, cursor, entry);
    cursor += valueBytes(entry);
  });
  view.setUint32(ifdAt + 2 + entries.length * IFD_ENTRY_BYTES, nextIfdAt, true);
  return ifdAt;
}

function assemble(planned: PlannedPage[]): ArrayBuffer {
  const sizes = planned.map(pageBytes);
  const buffer = new ArrayBuffer(HEADER_BYTES + sizes.reduce((total, size) => total + size, 0));
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  const pageOffsets: number[] = [];
  sizes.reduce((at, size) => (pageOffsets.push(at), at + size), HEADER_BYTES);
  let nextIfdAt = 0;
  for (let index = planned.length - 1; index >= 0; index--) {
    nextIfdAt = writePage(view, planned[index]!, pageOffsets[index]!, nextIfdAt);
  }
  view.setUint32(4, nextIfdAt, true);
  return buffer;
}

function plan(
  pages: readonly TiffFixturePage[],
  options: TiffFixtureOptions,
  compression: number,
): PlannedPage[] {
  return pages.map((page) => {
    const rowsPerStrip = page.claimsSizeWithoutPixels
      ? page.height
      : Math.min(options.rowsPerStrip ?? page.height, page.height);
    return { page, compression, rowsPerStrip, strips: rawStrips(page, rowsPerStrip) };
  });
}

const ENCODERS = { none: (strip: Uint8Array) => strip, lzw: lzwEncode, packbits: packBitsEncode };

const encodedWith = (planned: PlannedPage, encode: (strip: Uint8Array) => Uint8Array): Uint8Array[] =>
  planned.page.claimsSizeWithoutPixels ? planned.strips : planned.strips.map(encode);

/**
 * Builds a little-endian baseline TIFF: 8-bit RGB strips (`rowsPerStrip` rows each, one strip per page by
 * default), each page filled with `rgb`, stored uncompressed, LZW or PackBits. A page with
 * `claimsSizeWithoutPixels` declares its size in the tags but carries 3 bytes of pixels, so it must never
 * be decoded.
 *
 * @example
 * ```ts
 * const data = tiffBytes([{ width: 40, height: 30 }, { width: 20, height: 20, rgb: [0, 0, 255] }]);
 * ```
 */
export function tiffBytes(pages: readonly TiffFixturePage[], options: TiffFixtureOptions = {}): ArrayBuffer {
  const compression = options.compression ?? 'none';
  const planned = plan(pages, options, COMPRESSION_CODES[compression]);
  return assemble(planned.map((page) => ({ ...page, strips: encodedWith(page, ENCODERS[compression]) })));
}

async function zlibDeflate(strip: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([strip]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Like `tiffBytes`, with each strip zlib-deflated by `CompressionStream` (TIFF compression 8).
 *
 * @example
 * ```ts
 * const data = await deflatedTiffBytes([{ width: 40, height: 30 }], { rowsPerStrip: 8 });
 * ```
 */
export async function deflatedTiffBytes(
  pages: readonly TiffFixturePage[],
  options: Pick<TiffFixtureOptions, 'rowsPerStrip'> = {},
): Promise<ArrayBuffer> {
  const planned = plan(pages, options, COMPRESSION_CODES.deflate);
  const deflated = await Promise.all(
    planned.map(async (page) => ({
      ...page,
      strips: await Promise.all(page.strips.map((strip) => zlibDeflate(strip as Uint8Array<ArrayBuffer>))),
    })),
  );
  return assemble(deflated);
}

export interface RawTiffEntry {
  tag: number;
  type: number;
  count: number;
  value?: number;
  shorts?: readonly number[];
}

export interface RawTiffDirectory {
  at: number;
  entries: readonly RawTiffEntry[];
  next?: number;
}

/**
 * Writes directories exactly as given, with no checks, into a little-endian TIFF of `size` bytes: for
 * crafting malformed files. An entry's `shorts` are written inline; otherwise `value` is its 4-byte value
 * or offset.
 *
 * @example
 * ```ts
 * const data = rawTiff(64, [{ at: 8, entries: [{ tag: 256, type: 4, count: 1, value: 10 }] }]);
 * ```
 */
export function rawTiff(size: number, directories: readonly RawTiffDirectory[]): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, directories[0]?.at ?? 0, true);
  for (const directory of directories) {
    view.setUint16(directory.at, directory.entries.length, true);
    directory.entries.forEach((entry, index) => {
      const entryAt = directory.at + 2 + index * IFD_ENTRY_BYTES;
      view.setUint16(entryAt, entry.tag, true);
      view.setUint16(entryAt + 2, entry.type, true);
      view.setUint32(entryAt + 4, entry.count, true);
      if (entry.shorts) {
        entry.shorts.forEach((short, slot) => view.setUint16(entryAt + 8 + slot * 2, short, true));
      } else view.setUint32(entryAt + 8, entry.value ?? 0, true);
    });
    view.setUint32(directory.at + 2 + directory.entries.length * IFD_ENTRY_BYTES, directory.next ?? 0, true);
  }
  return buffer;
}
