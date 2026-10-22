const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const INLINE_VALUE_BYTES = 4;
const LITTLE_ENDIAN_MARK = 0x4949;
const BIG_ENDIAN_MARK = 0x4d4d;
const TIFF_MAGIC = 42;
const MAX_PAGES = 10_000;
const MAX_ENTRIES_PER_DIRECTORY = 4_096;
const MAX_ENTRIES_PER_FILE = 65_536;
const BYTE = 1;
const SHORT = 3;
const LONG = 4;
const BYTES_PER_VALUE: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

/**
 * The TIFF tags the viewer reads, by name. Every other tag (SubIFDs, EXIF, GPS, maker notes, DNG data) is
 * skipped without being followed.
 *
 * @example
 * ```ts
 * const width = directory.values.get(TAG.imageWidth)?.[0];
 * ```
 */
export const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planarConfiguration: 284,
  predictor: 317,
  colorMap: 320,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  extraSamples: 338,
  sampleFormat: 339,
} as const;

const READ_TAGS: ReadonlySet<number> = new Set(Object.values(TAG));

/**
 * The largest page the viewer decodes: at most `maxSide` px a side and `maxPixels` in all, with tile sides
 * a multiple of `tileSideMultiple` px.
 *
 * @example
 * ```ts
 * const fits = width <= PAGE_LIMITS.maxSide && width * height <= PAGE_LIMITS.maxPixels;
 * ```
 */
export const PAGE_LIMITS = { maxSide: 32_767, maxPixels: 100_000_000, tileSideMultiple: 16 } as const;

const SMALLEST_TILE_PIXELS = PAGE_LIMITS.tileSideMultiple ** 2;
const MOST_TILES_A_SIDE = Math.ceil(PAGE_LIMITS.maxSide / PAGE_LIMITS.tileSideMultiple);
const MOST_SEGMENTS_IN_A_PAGE =
  Math.ceil(PAGE_LIMITS.maxPixels / SMALLEST_TILE_PIXELS) + 2 * MOST_TILES_A_SIDE + 1;
const SEGMENT_TAGS: ReadonlySet<number> = new Set([
  TAG.stripOffsets,
  TAG.stripByteCounts,
  TAG.tileOffsets,
  TAG.tileByteCounts,
]);

/**
 * One page's image file directory: the values of the tags in {@link TAG}.
 *
 * @example
 * ```ts
 * const compression = directory.values.get(TAG.compression)?.[0] ?? 1;
 * ```
 */
export interface TiffDirectory {
  values: ReadonlyMap<number, readonly number[]>;
}

interface DirectoryReader {
  view: DataView;
  littleEndian: boolean;
  declaredValueBytes: number;
  entriesRead: number;
}

function malformed(reason: string): Error {
  return new Error(`This TIFF is malformed: ${reason}. Open it in an image editor and save it again`);
}

function valuesAt(reader: DirectoryReader, valueAt: number, type: number, count: number): number[] {
  const { view, littleEndian } = reader;
  return Array.from({ length: count }, (_, index) => {
    if (type === SHORT) return view.getUint16(valueAt + index * 2, littleEndian);
    if (type === LONG) return view.getUint32(valueAt + index * 4, littleEndian);
    return view.getUint8(valueAt + index);
  });
}

function readEntry(reader: DirectoryReader, entryAt: number): { tag: number; values: number[] } | undefined {
  const { view, littleEndian } = reader;
  const tag = view.getUint16(entryAt, littleEndian);
  const type = view.getUint16(entryAt + 2, littleEndian);
  const count = view.getUint32(entryAt + 4, littleEndian);
  const valueBytes = (BYTES_PER_VALUE[type] ?? 0) * count;
  reader.declaredValueBytes += valueBytes;
  if (reader.declaredValueBytes > view.byteLength) {
    throw malformed('its tags declare more data than the file holds');
  }
  const valueAt = valueBytes <= INLINE_VALUE_BYTES ? entryAt + 8 : view.getUint32(entryAt + 8, littleEndian);
  if (valueAt + valueBytes > view.byteLength) throw malformed(`tag ${tag} points past the end of the file`);
  const isNumber = type === BYTE || type === SHORT || type === LONG;
  const moreSegmentsThanAnyPage = SEGMENT_TAGS.has(tag) && count > MOST_SEGMENTS_IN_A_PAGE;
  if (!READ_TAGS.has(tag) || !isNumber || moreSegmentsThanAnyPage) return undefined;
  return { tag, values: valuesAt(reader, valueAt, type, count) };
}

function readDirectory(reader: DirectoryReader, offset: number): { directory: TiffDirectory; next: number } {
  const { view, littleEndian } = reader;
  if (offset < HEADER_BYTES || offset + 2 > view.byteLength) throw malformed('a directory is out of bounds');
  const entryCount = view.getUint16(offset, littleEndian);
  if (entryCount > MAX_ENTRIES_PER_DIRECTORY) {
    throw malformed(`a directory has over ${MAX_ENTRIES_PER_DIRECTORY} tags`);
  }
  reader.entriesRead += entryCount;
  if (reader.entriesRead > MAX_ENTRIES_PER_FILE) {
    throw malformed(`it has over ${MAX_ENTRIES_PER_FILE} tags in all`);
  }
  const nextPointerAt = offset + 2 + entryCount * ENTRY_BYTES;
  if (nextPointerAt + 4 > view.byteLength) throw malformed('a directory runs past the end of the file');
  const values = new Map<number, readonly number[]>();
  for (let index = 0; index < entryCount; index++) {
    const entry = readEntry(reader, offset + 2 + index * ENTRY_BYTES);
    if (entry) values.set(entry.tag, entry.values);
  }
  return { directory: { values }, next: view.getUint32(nextPointerAt, littleEndian) };
}

function byteOrderOf(view: DataView): boolean {
  if (view.byteLength < HEADER_BYTES) throw malformed('it is too short to be a TIFF');
  const byteOrder = view.getUint16(0);
  if (byteOrder !== LITTLE_ENDIAN_MARK && byteOrder !== BIG_ENDIAN_MARK) {
    throw malformed('it does not start with a TIFF byte-order mark');
  }
  const littleEndian = byteOrder === LITTLE_ENDIAN_MARK;
  if (view.getUint16(2, littleEndian) !== TIFF_MAGIC) throw malformed('it is not a baseline TIFF');
  return littleEndian;
}

/**
 * Reads a TIFF's top-level image directories, in order, keeping only the tags in {@link TAG}. Nothing else
 * is followed, so the work is bounded by the file: at most 10,000 directories of at most 4,096 entries and
 * 65,536 entries in all, every value inside the file, and all declared values together no larger than the
 * file. Throws an `Error` saying what is wrong when the file breaks any of these, or when its chain loops.
 * Strip and tile tags with more values than a page within `PAGE_LIMITS` can have are left out unread, so
 * that page is refused as malformed.
 *
 * @example
 * ```ts
 * const directories = readTiffDirectories(await file.arrayBuffer());
 * ```
 */
export function readTiffDirectories(data: ArrayBuffer): TiffDirectory[] {
  const view = new DataView(data);
  const littleEndian = byteOrderOf(view);
  const reader: DirectoryReader = { view, littleEndian, declaredValueBytes: 0, entriesRead: 0 };
  const directories: TiffDirectory[] = [];
  const visited = new Set<number>();
  for (let offset = view.getUint32(4, littleEndian); offset !== 0;) {
    if (visited.has(offset)) throw malformed('its directory chain loops');
    if (directories.length === MAX_PAGES) throw malformed(`it has more than ${MAX_PAGES} pages`);
    visited.add(offset);
    const { directory, next } = readDirectory(reader, offset);
    directories.push(directory);
    offset = next;
  }
  return directories;
}
