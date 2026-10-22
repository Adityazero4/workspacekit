import { viewerError, type ViewerError } from '../../viewer/errors';
import { PAGE_LIMITS, TAG, type TiffDirectory } from './tiffDirectory';

const MAX_PAGE_PIXELS = PAGE_LIMITS.maxPixels;
const MAX_DIMENSION = PAGE_LIMITS.maxSide;
const MAX_PAGE_BYTES = 400_000_000;
const SUPPORTED_BITS_PER_SAMPLE: ReadonlySet<number> = new Set([1, 2, 4, 8, 16]);
const MAX_SAMPLES_PER_PIXEL = 4;
const TILE_SIDE_MULTIPLE = PAGE_LIMITS.tileSideMultiple;
const UNSUPPORTED_COMPRESSION_MESSAGE =
  "This TIFF uses a compression this viewer doesn't support. Download it to open it.";

/**
 * TIFF compression codes the viewer decodes: none, LZW, Deflate (both codes) and PackBits. Everything else,
 * JPEG included, is refused per page.
 *
 * @example
 * ```ts
 * const isLzw = layout.compression === COMPRESSION.lzw;
 * ```
 */
export const COMPRESSION = {
  none: 1,
  lzw: 5,
  deflate: 8,
  adobeDeflate: 32946,
  packBits: 32773,
} as const;

const SUPPORTED_COMPRESSIONS: ReadonlySet<number> = new Set(Object.values(COMPRESSION));

/**
 * One strip or tile: where its stored bytes are in the file, and how many bytes it decodes to.
 *
 * @example
 * ```ts
 * const stored = file.subarray(segment.offset, segment.offset + segment.byteCount);
 * ```
 */
export interface Segment {
  offset: number;
  byteCount: number;
  decodedBytes: number;
}

/**
 * Everything needed to decode a page, all of it checked against the file and the page budgets.
 * `segmentSize` is the pixel size of one strip (`rowsPerStrip` rows) or one tile.
 *
 * @example
 * ```ts
 * const rawBytes = layout.segments.reduce((total, segment) => total + segment.decodedBytes, 0);
 * ```
 */
export interface PageLayout {
  width: number;
  height: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  compression: number;
  directory: TiffDirectory;
  segments: Segment[];
  segmentSize: { width: number; height: number };
  isTiled: boolean;
}

/**
 * A page as the viewer lays it out: its size from the tags, and either the layout to decode it with or
 * the reason it cannot be shown (`too_large`, `load_error`, or `unsupported_media` for a compression
 * the viewer does not decode).
 *
 * @example
 * ```ts
 * const canDecode = (page: TiffPageReading): boolean => 'layout' in page;
 * ```
 */
export type TiffPageReading =
  | { width: number; height: number; layout: PageLayout }
  | { width: number; height: number; problem: ViewerError };

const first = (directory: TiffDirectory, tag: number): number | undefined => directory.values.get(tag)?.[0];
const unsupportedLayout = (reason: string): ViewerError =>
  viewerError('load_error', new Error(`${reason}; open the file in an image editor to convert it`));

interface Sampling {
  bitsPerSample: number;
  samplesPerPixel: number;
}

function samplingOf(directory: TiffDirectory): Sampling | ViewerError {
  const bits = directory.values.get(TAG.bitsPerSample) ?? [1];
  const samplesPerPixel = first(directory, TAG.samplesPerPixel) ?? 1;
  const bitsPerSample = bits[0] ?? 1;
  const isSupported =
    SUPPORTED_BITS_PER_SAMPLE.has(bitsPerSample) &&
    bits.every((value) => value === bitsPerSample) &&
    samplesPerPixel >= 1 &&
    samplesPerPixel <= MAX_SAMPLES_PER_PIXEL;
  if (!isSupported) {
    return unsupportedLayout(`${bits.join('/')} bits in ${samplesPerPixel} samples per pixel`);
  }
  const isPlanarWithSeveralSamples = first(directory, TAG.planarConfiguration) === 2 && samplesPerPixel > 1;
  if (isPlanarWithSeveralSamples) return unsupportedLayout('Separate color planes are not supported');
  const predictor = first(directory, TAG.predictor) ?? 1;
  const isSupportedPredictor = predictor === 1 || (predictor === 2 && bitsPerSample >= 8);
  if (!isSupportedPredictor) {
    return unsupportedLayout(`Predictor ${predictor} with ${bitsPerSample}-bit samples is not supported`);
  }
  return { bitsPerSample, samplesPerPixel };
}

const rowBytesOf = (width: number, sampling: Sampling): number =>
  Math.ceil((width * sampling.bitsPerSample * sampling.samplesPerPixel) / 8);

function isWithinBudget(width: number, height: number, sampling: Sampling): boolean {
  return (
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    width * height <= MAX_PAGE_PIXELS &&
    4 * width * height <= MAX_PAGE_BYTES &&
    rowBytesOf(width, sampling) * height <= MAX_PAGE_BYTES
  );
}

interface SegmentGrid {
  count: number;
  segmentSize: { width: number; height: number };
  decodedBytesAt: (index: number) => number;
}

function stripGrid(
  directory: TiffDirectory,
  width: number,
  height: number,
  rowBytes: number,
): SegmentGrid | undefined {
  const rowsPerStrip = Math.min(first(directory, TAG.rowsPerStrip) ?? height, height);
  if (rowsPerStrip < 1) return undefined;
  return {
    count: Math.ceil(height / rowsPerStrip),
    segmentSize: { width, height: rowsPerStrip },
    decodedBytesAt: (index) => Math.min(rowsPerStrip, height - index * rowsPerStrip) * rowBytes,
  };
}

function tileGrid(
  directory: TiffDirectory,
  page: { width: number; height: number },
  sampling: Sampling,
): SegmentGrid | undefined {
  const width = first(directory, TAG.tileWidth) ?? 0;
  const height = first(directory, TAG.tileLength) ?? 0;
  const isSpecTileSize = width % TILE_SIDE_MULTIPLE === 0 && height % TILE_SIDE_MULTIPLE === 0;
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || !isSpecTileSize) {
    return undefined;
  }
  const count = Math.ceil(page.width / width) * Math.ceil(page.height / height);
  const tileBytes = rowBytesOf(width, sampling) * height;
  if (count * tileBytes > MAX_PAGE_BYTES) return undefined;
  return { count, segmentSize: { width, height }, decodedBytesAt: () => tileBytes };
}

function segmentsOf(
  offsets: readonly number[] | undefined,
  byteCounts: readonly number[] | undefined,
  grid: SegmentGrid,
  fileBytes: number,
): Segment[] | undefined {
  if (offsets?.length !== grid.count || byteCounts?.length !== grid.count) return undefined;
  let storedBytes = 0;
  const segments: Segment[] = [];
  for (const [index, offset] of offsets.entries()) {
    const byteCount = byteCounts[index] ?? 0;
    storedBytes += byteCount;
    if (offset + byteCount > fileBytes || storedBytes > fileBytes) return undefined;
    segments.push({ offset, byteCount, decodedBytes: grid.decodedBytesAt(index) });
  }
  return segments;
}

function layoutOf(
  directory: TiffDirectory,
  page: { width: number; height: number },
  sampling: Sampling,
  fileBytes: number,
): PageLayout | ViewerError {
  const isTiled = directory.values.has(TAG.tileWidth);
  const grid = isTiled
    ? tileGrid(directory, page, sampling)
    : stripGrid(directory, page.width, page.height, rowBytesOf(page.width, sampling));
  if (!grid) {
    return unsupportedLayout(isTiled ? 'Its tiles are malformed or too large' : 'Its strips are malformed');
  }
  const segments = segmentsOf(
    directory.values.get(isTiled ? TAG.tileOffsets : TAG.stripOffsets),
    directory.values.get(isTiled ? TAG.tileByteCounts : TAG.stripByteCounts),
    grid,
    fileBytes,
  );
  if (!segments) return unsupportedLayout('Its image data lies outside the file or does not match its size');
  const compression = first(directory, TAG.compression) ?? COMPRESSION.none;
  return { ...page, ...sampling, compression, directory, segments, segmentSize: grid.segmentSize, isTiled };
}

/**
 * Reads one directory as a page, checking it before anything is allocated: each side at most 32,767 px,
 * at most 100 megapixels, at most 400 MB of raw samples and of RGBA; 1, 2, 4, 8 or 16 bits in 1 to 4
 * samples; strips or tiles that match the page and lie inside the file (their count is compared with the
 * offsets before any per-strip work); none, LZW, Deflate or PackBits compression. Returns `undefined` for a
 * directory without an image size (such as a metadata-only directory).
 *
 * @example
 * ```ts
 * const [directory] = readTiffDirectories(data);
 * const page = directory && readTiffPage(directory, data.byteLength);
 * ```
 */
export function readTiffPage(directory: TiffDirectory, fileBytes: number): TiffPageReading | undefined {
  const width = first(directory, TAG.imageWidth) ?? 0;
  const height = first(directory, TAG.imageLength) ?? 0;
  if (width < 1 || height < 1) return undefined;
  const page = { width, height };
  const sampling = samplingOf(directory);
  if ('kind' in sampling) return { ...page, problem: sampling };
  if (!isWithinBudget(width, height, sampling)) return { ...page, problem: viewerError('too_large') };
  const compression = first(directory, TAG.compression) ?? COMPRESSION.none;
  if (!SUPPORTED_COMPRESSIONS.has(compression)) {
    return { ...page, problem: { kind: 'unsupported_media', message: UNSUPPORTED_COMPRESSION_MESSAGE } };
  }
  const layout = layoutOf(directory, page, sampling, fileBytes);
  return 'kind' in layout ? { ...page, problem: layout } : { ...page, layout };
}
