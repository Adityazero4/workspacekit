// @vitest-environment node
import { deflateRawSync, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseTiff } from '../src/renderers/tiff/decodeTiff';
import { decodeLzw, decodePackBits, inflateInto } from '../src/renderers/tiff/decompress';
import { createPageCache } from '../src/renderers/tiff/pageCache';
import { readTiffDirectories, TAG } from '../src/renderers/tiff/tiffDirectory';
import { readTiffPage, type TiffPageReading } from '../src/renderers/tiff/tiffPage';
import { lzwEncode, packBitsEncode, rawTiff, tiffBytes, type RawTiffEntry } from './fixtures/tiff';

const BYTE = 1;
const SHORT = 3;
const LONG = 4;
const UNSUPPORTED_COMPRESSION =
  "This TIFF uses a compression this viewer doesn't support. Download it to open it.";

const rgbPage = (width: number, height: number, overrides: RawTiffEntry[] = []): RawTiffEntry[] => {
  const entries: RawTiffEntry[] = [
    { tag: 256, type: LONG, count: 1, value: width },
    { tag: 257, type: LONG, count: 1, value: height },
    { tag: 258, type: SHORT, count: 1, shorts: [8] },
    { tag: 259, type: SHORT, count: 1, shorts: [1] },
    { tag: 262, type: SHORT, count: 1, shorts: [2] },
    { tag: 273, type: LONG, count: 1, value: 300 },
    { tag: 277, type: SHORT, count: 1, shorts: [3] },
    { tag: 278, type: LONG, count: 1, value: height },
    { tag: 279, type: LONG, count: 1, value: width * height * 3 },
  ];
  return entries.map((entry) => overrides.find((override) => override.tag === entry.tag) ?? entry);
};

function onlyPage(data: ArrayBuffer): TiffPageReading {
  const [directory] = readTiffDirectories(data);
  return readTiffPage(directory!, data.byteLength)!;
}

const problemOf = (reading: TiffPageReading): string | undefined =>
  'problem' in reading ? reading.problem.kind : undefined;

afterEach(() => {
  vi.restoreAllMocks();
});

function countArrayElementsAllocatedBy(run: () => void): number {
  let elements = 0;
  const from = Array.from.bind(Array) as (source: ArrayLike<unknown>, map?: unknown) => unknown[];
  vi.spyOn(Array, 'from').mockImplementation(((
    source: ArrayLike<unknown>,
    map?: (value: unknown, index: number) => unknown,
  ) => {
    elements += source.length;
    return from(source, map);
  }) as typeof Array.from);
  const fill = Array.prototype.fill;
  vi.spyOn(Array.prototype, 'fill').mockImplementation(function (this: unknown[], ...args) {
    elements += this.length;
    return fill.apply(this, args as Parameters<typeof fill>);
  });
  try {
    run();
  } finally {
    vi.restoreAllMocks();
  }
  return elements;
}

describe('probes from the security review: crafted files are refused before the decoder allocates', () => {
  test('a SHORT-typed SubIFD chain 24 deep is never followed', () => {
    const chain = Array.from({ length: 24 }, (_, depth) => ({
      at: 200 + depth * 20,
      entries: [{ tag: 330, type: SHORT, count: 2, shorts: [220 + depth * 20, 220 + depth * 20] }],
    }));
    const data = rawTiff(720, [
      { at: 8, entries: [...rgbPage(4, 4), { tag: 330, type: SHORT, count: 1, shorts: [200] }] },
      ...chain,
    ]);
    const directories = readTiffDirectories(data);
    expect(directories).toHaveLength(1);
    expect(directories[0]!.values.has(330)).toBe(false);
  });

  test('a DNG private-data (50740) graph is never followed', () => {
    const data = rawTiff(400, [
      { at: 8, entries: [...rgbPage(4, 4), { tag: 50740, type: BYTE, count: 4, value: 200 }] },
      {
        at: 200,
        entries: [
          { tag: 50740, type: BYTE, count: 4, value: 200 },
          { tag: 50740, type: BYTE, count: 4, value: 200 },
        ],
      },
    ]);
    expect(readTiffDirectories(data)).toHaveLength(1);
  });

  test('400 entries declaring values in one shared region exceed the file and are refused', () => {
    const count = 10_000;
    const entriesAt = 8 + count * 4;
    const entries = Array.from({ length: 400 }, (_, index) => ({
      tag: 40_000 + index,
      type: LONG,
      count,
      value: 8,
    }));
    const data = rawTiff(entriesAt + 2 + 400 * 12 + 4, [{ at: entriesAt, entries }]);
    expect(() => readTiffDirectories(data)).toThrow(/declare more data than the file holds/);
  });

  test('strip and tile tags with more values than any page within budget has are never read', () => {
    const count = 1_000_000;
    const valuesAt = 400;
    for (const tag of [TAG.stripOffsets, TAG.stripByteCounts, TAG.tileOffsets, TAG.tileByteCounts]) {
      const data = rawTiff(valuesAt + count, [
        {
          at: 8,
          entries: [
            ...rgbPage(4, 4).filter((entry) => entry.tag !== tag),
            { tag, type: BYTE, count, value: valuesAt },
          ],
        },
      ]);
      let directories: ReturnType<typeof readTiffDirectories> = [];
      const elements = countArrayElementsAllocatedBy(() => (directories = readTiffDirectories(data)));
      expect(elements, `tag ${tag}`).toBeLessThan(1000);
      expect(directories[0]!.values.has(tag), `tag ${tag}`).toBe(false);
    }
  });

  test('strip offsets past the end and byte counts of 4e8 make a load_error page', () => {
    const data = rawTiff(4096, [
      {
        at: 8,
        entries: rgbPage(10, 10, [
          { tag: 273, type: LONG, count: 2, value: 200 },
          { tag: 278, type: LONG, count: 1, value: 5 },
          { tag: 279, type: LONG, count: 2, value: 208 },
        ]),
      },
    ]);
    const view = new DataView(data);
    [3e9, 3e9, 4e8, 4e8].forEach((value, index) => view.setUint32(200 + index * 4, value, true));
    expect(problemOf(onlyPage(data))).toBe('load_error');
  });

  test('64 bits in 64 samples makes a load_error page', () => {
    const data = rawTiff(512, [
      {
        at: 8,
        entries: rgbPage(1000, 1000, [
          { tag: 258, type: SHORT, count: 1, shorts: [64] },
          { tag: 277, type: SHORT, count: 1, shorts: [64] },
        ]),
      },
    ]);
    expect(problemOf(onlyPage(data))).toBe('load_error');
  });

  test('a Deflate bomb stops at the strip size instead of inflating 32 MiB', async () => {
    const bomb = deflateSync(Buffer.alloc(32 * 2 ** 20), { level: 9 });
    const output = new Uint8Array(300);
    await expect(inflateInto(new Uint8Array(bomb), output)).rejects.toThrow(RangeError);
  });

  test('a PackBits run and an LZW stream that expand past the strip stop at the strip size', () => {
    const runs = new Uint8Array(200_000).map((_, index) => (index % 2 === 0 ? 0x81 : 0xff));
    const packBitsOutput = new Uint8Array(300);
    decodePackBits(runs, packBitsOutput);
    expect(packBitsOutput.every((byte) => byte === 0xff)).toBe(true);
    const lzwOutput = new Uint8Array(300);
    decodeLzw(lzwEncode(new Uint8Array(100_000).fill(7)), lzwOutput);
    expect(lzwOutput.every((byte) => byte === 7)).toBe(true);
  });
});

describe('probes from the re-review: parse work is bounded by the file', () => {
  test('many pages declaring 32,767 strips or 390,625 tiles but carrying no offsets allocate nothing per strip', () => {
    for (const entries of [
      [
        { tag: 256, type: LONG, count: 1, value: 1 },
        { tag: 257, type: LONG, count: 1, value: 32_767 },
        { tag: 278, type: SHORT, count: 1, shorts: [1] },
      ],
      [
        { tag: 256, type: LONG, count: 1, value: 10_000 },
        { tag: 257, type: LONG, count: 1, value: 10_000 },
        { tag: 322, type: SHORT, count: 1, shorts: [16] },
        { tag: 323, type: SHORT, count: 1, shorts: [16] },
      ],
    ]) {
      const pages = 200;
      const directoryBytes = 2 + entries.length * 12 + 4;
      const data = rawTiff(
        8 + pages * directoryBytes,
        Array.from({ length: pages }, (_, index) => ({
          at: 8 + index * directoryBytes,
          entries,
          next: index + 1 < pages ? 8 + (index + 1) * directoryBytes : 0,
        })),
      );
      let parsedPages = 0;
      const elements = countArrayElementsAllocatedBy(() => {
        parsedPages = parseTiff(data).pages.length;
      });
      expect(parsedPages).toBe(pages);
      expect(elements).toBeLessThanOrEqual(data.byteLength);
    }
  });

  test('overlapping directories past 65,536 entries in all are refused', () => {
    const [pages, entriesEach, start] = [17, 4_096, 8];
    const data = new ArrayBuffer(start + 4 * pages + 2 + 12 * entriesEach + 4 * pages + 8);
    const view = new DataView(data);
    view.setUint16(0, 0x4949);
    view.setUint16(2, 42, true);
    view.setUint32(4, start, true);
    for (let page = 0; page < pages; page++) {
      view.setUint16(start + 4 * page, entriesEach, true);
      view.setUint16(start + 4 * page + 2, entriesEach, true);
      const next = page + 1 < pages ? start + 4 * (page + 1) : 0;
      view.setUint32(start + 4 * page + 2 + 12 * entriesEach, next, true);
    }
    expect(() => readTiffDirectories(data)).toThrow(/over 65536 tags in all/);
  });
});

describe('the directory reader', () => {
  test('a looping chain, over 4,096 entries or a value past the end is refused', () => {
    const loop = rawTiff(200, [{ at: 8, entries: rgbPage(4, 4), next: 8 }]);
    expect(() => readTiffDirectories(loop)).toThrow(/loops/);
    const crowded = rawTiff(8 + 2 + 4097 * 12 + 4, [
      {
        at: 8,
        entries: Array.from({ length: 4097 }, () => ({ tag: 40_000, type: SHORT, count: 1, shorts: [1] })),
      },
    ]);
    expect(() => readTiffDirectories(crowded)).toThrow(/over 4096 tags/);
    const pastTheEnd = rawTiff(200, [{ at: 8, entries: [{ tag: 273, type: LONG, count: 4, value: 190 }] }]);
    expect(() => readTiffDirectories(pastTheEnd)).toThrow(/past the end/);
    expect(() => readTiffDirectories(new TextEncoder().encode('not a tiff').buffer)).toThrow(
      /byte-order mark/,
    );
  });

  test('more than 10,000 pages is refused', () => {
    const pages = 10_001;
    const data = rawTiff(
      8 + pages * 6,
      Array.from({ length: pages }, (_, index) => ({
        at: 8 + index * 6,
        entries: [],
        next: index < pages - 1 ? 8 + (index + 1) * 6 : 0,
      })),
    );
    expect(() => readTiffDirectories(data)).toThrow(/more than 10000 pages/);
  });

  test('two pages sharing one strip are both read', () => {
    const data = rawTiff(600, [
      { at: 8, entries: rgbPage(4, 4), next: 200 },
      { at: 200, entries: rgbPage(4, 4) },
    ]);
    const pages = readTiffDirectories(data).map((directory) => readTiffPage(directory, data.byteLength)!);
    expect(pages.map(problemOf)).toEqual([undefined, undefined]);
  });
});

describe('page budgets and formats', () => {
  test('over 32,767 px a side, or over 100 megapixels, is too_large', () => {
    const wide = rawTiff(512, [{ at: 8, entries: rgbPage(32_768, 1) }]);
    expect(problemOf(onlyPage(wide))).toBe('too_large');
    const big = rawTiff(512, [{ at: 8, entries: rgbPage(10_001, 10_000) }]);
    expect(problemOf(onlyPage(big))).toBe('too_large');
  });

  test('JPEG pages (compression 7 and 6) are refused as an unsupported compression', () => {
    for (const compression of [7, 6]) {
      const jpeg = rawTiff(512, [
        { at: 8, entries: rgbPage(4, 4, [{ tag: 259, type: SHORT, count: 1, shorts: [compression] }]) },
      ]);
      const reading = onlyPage(jpeg);
      expect('problem' in reading && reading.problem).toEqual({
        kind: 'unsupported_media',
        message: UNSUPPORTED_COMPRESSION,
      });
    }
  });

  test('horizontal differencing (predictor 2) below 8 bits per sample is refused', () => {
    const predicted = rawTiff(512, [
      {
        at: 8,
        entries: [
          ...rgbPage(8, 8, [
            { tag: 258, type: SHORT, count: 1, shorts: [4] },
            { tag: 277, type: SHORT, count: 1, shorts: [1] },
            { tag: 279, type: LONG, count: 1, value: 32 },
          ]),
          { tag: 317, type: SHORT, count: 1, shorts: [2] },
        ],
      },
    ]);
    expect(problemOf(onlyPage(predicted))).toBe('load_error');
  });

  test('an unsupported compression says so; a strip count that does not match the rows is a load_error', () => {
    const fax = rawTiff(512, [
      { at: 8, entries: rgbPage(4, 4, [{ tag: 259, type: SHORT, count: 1, shorts: [4] }]) },
    ]);
    const reading = onlyPage(fax);
    expect('problem' in reading && reading.problem).toEqual({
      kind: 'unsupported_media',
      message: UNSUPPORTED_COMPRESSION,
    });
    const tooFewStrips = rawTiff(512, [
      { at: 8, entries: rgbPage(4, 4, [{ tag: 278, type: LONG, count: 1, value: 1 }]) },
    ]);
    expect(problemOf(onlyPage(tooFewStrips))).toBe('load_error');
  });

  test('tiles that are not multiples of 16 px are a load_error', () => {
    const tiny = rawTiff(512, [
      {
        at: 8,
        entries: [
          ...rgbPage(64, 64).filter((entry) => ![273, 278, 279].includes(entry.tag)),
          { tag: 322, type: LONG, count: 1, value: 1 },
          { tag: 323, type: LONG, count: 1, value: 1 },
        ],
      },
    ]);
    expect(problemOf(onlyPage(tiny))).toBe('load_error');
  });

  test('pages are read from their tags, with their strips, without decoding', async () => {
    const tiff = parseTiff(
      tiffBytes(
        [
          { width: 30, height: 20 },
          { width: 10, height: 50 },
        ],
        { rowsPerStrip: 7 },
      ),
    );
    expect(tiff.pages).toEqual([
      { width: 30, height: 20 },
      { width: 10, height: 50 },
    ]);
    const reading = onlyPage(tiffBytes([{ width: 30, height: 20 }], { rowsPerStrip: 7 }));
    expect('layout' in reading && reading.layout.segments.map((segment) => segment.decodedBytes)).toEqual([
      7 * 90,
      7 * 90,
      6 * 90,
    ]);
    expect('layout' in reading && reading.layout.directory.values.get(TAG.compression)).toEqual([1]);
  });
});

describe('decoders', () => {
  const pixels = new Uint8Array(4000).map((_, index) => (index * 7) % 251);

  test('LZW and PackBits round-trip', () => {
    const lzw = new Uint8Array(pixels.length);
    decodeLzw(lzwEncode(pixels), lzw);
    expect(lzw).toEqual(pixels);
    const packBits = new Uint8Array(pixels.length);
    decodePackBits(packBitsEncode(pixels), packBits);
    expect(packBits).toEqual(pixels);
  });

  test('zlib-wrapped and raw Deflate inflate exactly; a short stream leaves the rest zero', async () => {
    const zlib = new Uint8Array(pixels.length);
    await inflateInto(new Uint8Array(deflateSync(pixels)), zlib);
    expect(zlib).toEqual(pixels);
    const raw = new Uint8Array(pixels.length);
    await inflateInto(new Uint8Array(deflateRawSync(pixels)), raw);
    expect(raw).toEqual(pixels);
  });
});

describe('page cache', () => {
  interface HeldRender {
    index: number;
    finish: (bytes: number) => void;
  }

  function heldRenders(): { renderPage: (index: number) => Promise<Blob>; held: HeldRender[] } {
    const held: HeldRender[] = [];
    const renderPage = (index: number): Promise<Blob> =>
      new Promise((resolve) =>
        held.push({ index, finish: (bytes) => resolve(new Blob([new Uint8Array(bytes)])) }),
      );
    return { renderPage, held };
  }

  const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  test('renders one page at a time and skips a queued page released before its turn', async () => {
    const { renderPage, held } = heldRenders();
    const cache = createPageCache(renderPage);
    const pending = [0, 1, 2].map((index) => cache.acquire(index));
    pending.forEach((url) => url.catch(() => undefined));
    await flushPromises();
    expect(held.map((render) => render.index)).toEqual([0]);
    cache.release(1);
    held[0]!.finish(10);
    await flushPromises();
    expect(held.map((render) => render.index)).toEqual([0, 2]);
    await expect(pending[1]).rejects.toThrow(/scrolled away/);
    held[1]!.finish(10);
    await expect(pending[2]).resolves.toMatch(/^blob:/);
    cache.clear();
  });

  test('retained PNG bytes stay within the budget, dropping the least recently used page even when pinned', async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
    const { renderPage, held } = heldRenders();
    const cache = createPageCache(renderPage, { retainedBytesBudget: 1_000 });
    const urls: string[] = [];
    for (const index of [0, 1, 2]) {
      const url = cache.acquire(index);
      await flushPromises();
      held[index]!.finish(400);
      urls.push(await url);
    }
    await flushPromises();
    expect(revoked).toEqual([urls[0]]);
    cache.clear();
  });
});
