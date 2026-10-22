import type * as UtifModule from 'utif2';
import type { IFD } from 'utif2';
import type { ViewerError } from '../../viewer/errors';
import { decodeLzw, decodePackBits, inflateInto } from './decompress';
import { readTiffDirectories, TAG } from './tiffDirectory';
import { COMPRESSION, readTiffPage, type PageLayout } from './tiffPage';
import { TiffPageError } from './tiffPageError';

type Utif = typeof UtifModule;
type UtifTags = Record<string, readonly number[]>;

const BYTE_ORDER_MARK_BYTES = 2;
const PASSED_THROUGH_TAGS = [
  TAG.photometric,
  TAG.predictor,
  TAG.colorMap,
  TAG.extraSamples,
  TAG.sampleFormat,
];

/**
 * A TIFF page as the viewer lays it out: its size in px from the tags and, when it cannot be decoded, why
 * (`too_large`, `load_error` or `unsupported_media`), known before any pixels are read.
 *
 * @example
 * ```ts
 * const decodable = tiff.pages.filter((page) => !page.problem);
 * ```
 */
export interface TiffPageSize {
  width: number;
  height: number;
  problem?: ViewerError;
}

/**
 * A parsed TIFF: every page's size, and `renderPage`, which decodes one page into a PNG. A page with a
 * `problem` is refused without decoding.
 *
 * @example
 * ```ts
 * const firstPage: Blob = await tiff.renderPage(0);
 * ```
 */
export interface TiffFile {
  pages: readonly TiffPageSize[];
  renderPage: (index: number) => Promise<Blob>;
}

const loadUtif = async (): Promise<Utif> => (await import('utif2')).default;

function decodeSegment(
  compression: number,
  stored: Uint8Array<ArrayBuffer>,
  target: Uint8Array,
): Promise<void> | void {
  if (compression === COMPRESSION.lzw) return decodeLzw(stored, target);
  if (compression === COMPRESSION.packBits) return decodePackBits(stored, target);
  if (compression === COMPRESSION.none) return target.set(stored.subarray(0, target.length));
  return inflateInto(stored, target);
}

async function uncompressedSegments(
  file: Uint8Array<ArrayBuffer>,
  layout: PageLayout,
): Promise<Uint8Array<ArrayBuffer>> {
  const total = layout.segments.reduce((sum, segment) => sum + segment.decodedBytes, 0);
  const output = new Uint8Array(BYTE_ORDER_MARK_BYTES + total);
  output.set(file.subarray(0, BYTE_ORDER_MARK_BYTES));
  let at = BYTE_ORDER_MARK_BYTES;
  for (const { offset, byteCount, decodedBytes } of layout.segments) {
    await decodeSegment(
      layout.compression,
      file.subarray(offset, offset + byteCount),
      output.subarray(at, at + decodedBytes),
    );
    at += decodedBytes;
  }
  return output;
}

function segmentTags(layout: PageLayout, offsets: number[], byteCounts: number[]): UtifTags {
  if (layout.isTiled) {
    const { width, height } = layout.segmentSize;
    return { t322: [width], t323: [height], t324: offsets, t325: byteCounts };
  }
  return { t273: offsets, t278: [layout.segmentSize.height], t279: byteCounts };
}

function utifTags(layout: PageLayout, compression: number, segments: UtifTags): UtifTags {
  const tags: UtifTags = {
    t256: [layout.width],
    t257: [layout.height],
    t258: Array<number>(layout.samplesPerPixel).fill(layout.bitsPerSample),
    t259: [compression],
    t277: [layout.samplesPerPixel],
    ...segments,
  };
  for (const tag of PASSED_THROUGH_TAGS) {
    const values = layout.directory.values.get(tag);
    if (values) tags[`t${tag}`] = [...values];
  }
  return tags;
}

interface DecodableSource {
  buffer: ArrayBuffer;
  tags: UtifTags;
}

async function uncompressedSource(
  file: Uint8Array<ArrayBuffer>,
  layout: PageLayout,
): Promise<DecodableSource> {
  const uncompressed = await uncompressedSegments(file, layout);
  const byteCounts = layout.segments.map((segment) => segment.decodedBytes);
  let nextOffset = BYTE_ORDER_MARK_BYTES;
  const offsets = byteCounts.map((bytes) => {
    const offset = nextOffset;
    nextOffset += bytes;
    return offset;
  });
  const tags = utifTags(layout, COMPRESSION.none, segmentTags(layout, offsets, byteCounts));
  return { buffer: uncompressed.buffer, tags };
}

/* eslint-disable no-console -- utif2 logs on every tiled page; console.log is silenced only for this synchronous call and always restored */
function quietly<Result>(run: () => Result): Result {
  const log = console.log;
  console.log = () => undefined;
  try {
    return run();
  } finally {
    console.log = log;
  }
}
/* eslint-enable no-console */

function rgbaOf(utif: Utif, buffer: ArrayBuffer, tags: UtifTags): Uint8Array {
  const directory = { ...tags } as unknown as IFD;
  return quietly(() => {
    utif.decodeImage(buffer, directory);
    return utif.toRGBA8(directory);
  });
}

function drawPage(rgba: Uint8Array, layout: PageLayout): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser gave no 2D canvas to draw this page on; try again');
  const pixels = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
  context.putImageData(new ImageData(pixels, layout.width, layout.height), 0, 0);
  return canvas;
}

function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => {
      canvas.width = 0;
      canvas.height = 0;
      if (blob) resolve(blob);
      else reject(new TiffPageError('too_large', 'The browser could not draw a page this large'));
    }, 'image/png'),
  );
}

async function renderPage(file: Uint8Array<ArrayBuffer>, layout: PageLayout | undefined): Promise<Blob> {
  if (!layout) throw new RangeError('This page cannot be decoded; check its problem before rendering it');
  const utif = await loadUtif();
  const { buffer, tags } = await uncompressedSource(file, layout);
  return pngOf(drawPage(rgbaOf(utif, buffer, tags), layout));
}

/**
 * Reads a TIFF's pages without decoding any pixels: the top-level directories only, each page checked
 * against the budgets (see `readTiffPage`). Pixels are decoded one page at a time by `renderPage`, on the
 * main thread: strips and tiles are decompressed here with bounded decoders (LZW, PackBits, Deflate through
 * `DecompressionStream`) and handed to the TIFF decoder, loaded on first use, as an uncompressed page.
 * Throws when `data` is not a well-formed TIFF or has no image pages.
 *
 * @example
 * ```ts
 * const tiff = parseTiff(await file.arrayBuffer());
 * console.log(`${tiff.pages.length} pages`);
 * ```
 */
export function parseTiff(data: ArrayBuffer): TiffFile {
  const readings = readTiffDirectories(data).flatMap(
    (directory) => readTiffPage(directory, data.byteLength) ?? [],
  );
  if (readings.length === 0) {
    throw new Error('This TIFF has no image pages; check that it is not just metadata');
  }
  const file = new Uint8Array(data);
  return {
    pages: readings.map(({ width, height, ...reading }) =>
      'problem' in reading ? { width, height, problem: reading.problem } : { width, height },
    ),
    renderPage: (index) => {
      const reading = readings[index];
      return renderPage(file, reading && 'layout' in reading ? reading.layout : undefined);
    },
  };
}
