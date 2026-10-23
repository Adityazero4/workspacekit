import { Inflate } from 'fflate';
import { ReaderError, type ReadWork, type ReaderCaps } from '../types';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const LONGEST_ZIP_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED_FLAG = 1;
const MOST_ENTRIES = 10_000;
const COMPRESSED_CHUNK_BYTES = 1024;
const STORED_CHUNK_BYTES = 64 * 1024;

interface ZipEntry {
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

/**
 * An opened archive: the names of its entries, and `streamText`, which inflates one entry and hands its
 * text to `onText` chunk by chunk until `onText` returns `false`.
 *
 * @example
 * ```ts
 * const archive = openZip(bytes, caps, work);
 * archive.streamText('xl/workbook.xml', (text) => parser.write(text) && true);
 * ```
 */
export interface ZipArchive {
  names: ReadonlySet<string>;
  streamText: (name: string, onText: (text: string) => boolean) => void;
}

const notAWorkbook = (): ReaderError =>
  new ReaderError('load_error', 'This file is not a valid .xlsx workbook (its zip directory is damaged).');

function findEndRecord(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - END_RECORD_SIZE - LONGEST_ZIP_COMMENT);
  for (let offset = view.byteLength - END_RECORD_SIZE; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw notAWorkbook();
}

function readEntry(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): { name: string; entry: ZipEntry; next: number } {
  if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) {
    throw notAWorkbook();
  }
  const nameLength = view.getUint16(offset + 28, true);
  const next =
    offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  const entry: ZipEntry = {
    method: view.getUint16(offset + 10, true),
    compressedSize: view.getUint32(offset + 20, true),
    declaredSize: view.getUint32(offset + 24, true),
    localHeaderOffset: view.getUint32(offset + 42, true),
  };
  if ((view.getUint16(offset + 8, true) & ENCRYPTED_FLAG) !== 0) {
    throw new ReaderError(
      'password_protected',
      'This workbook is encrypted. Open it in a spreadsheet app instead.',
    );
  }
  if (entry.compressedSize === ZIP64_MARKER || entry.declaredSize === ZIP64_MARKER) {
    throw new ReaderError('too_large', 'This workbook is too large to preview (it needs a ZIP64 archive).');
  }
  const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
  return { name, entry, next };
}

function readCentralDirectory(bytes: Uint8Array, caps: ReaderCaps): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view);
  const count = view.getUint16(end + 10, true);
  if (count > MOST_ENTRIES) {
    throw new ReaderError('too_large', `This workbook has over ${MOST_ENTRIES} parts.`);
  }
  const entries = new Map<string, ZipEntry>();
  let declaredTotal = 0;
  for (let index = 0, offset = view.getUint32(end + 16, true); index < count; index++) {
    const { name, entry, next } = readEntry(view, bytes, offset);
    declaredTotal += entry.declaredSize;
    entries.set(name, entry);
    offset = next;
  }
  if (declaredTotal > caps.maxInflatedBytes) {
    throw new ReaderError(
      'too_large',
      `This workbook would inflate to ${declaredTotal} bytes, over the ${caps.maxInflatedBytes}-byte limit.`,
    );
  }
  return entries;
}

function compressedBytesOf(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.byteLength || view.getUint32(header, true) !== LOCAL_FILE_HEADER) {
    throw notAWorkbook();
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  if (start + entry.compressedSize > bytes.byteLength) throw notAWorkbook();
  return bytes.subarray(start, start + entry.compressedSize);
}

function countingSink(
  entry: ZipEntry,
  caps: ReaderCaps,
  work: ReadWork,
  onBytes: (chunk: Uint8Array) => void,
) {
  let entryBytes = 0;
  return (chunk: Uint8Array): void => {
    entryBytes += chunk.byteLength;
    work.inflatedBytes += chunk.byteLength;
    if (entryBytes > entry.declaredSize || work.inflatedBytes > caps.maxInflatedBytes) {
      throw new ReaderError(
        'too_large',
        'This workbook inflates past its declared size or the inflate limit.',
      );
    }
    onBytes(chunk);
  };
}

function inflateEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  sink: (chunk: Uint8Array) => void,
  isStopped: () => boolean,
): void {
  const compressed = compressedBytesOf(bytes, entry);
  if (entry.method === STORED) {
    for (let start = 0; start < compressed.byteLength && !isStopped(); start += STORED_CHUNK_BYTES) {
      sink(compressed.subarray(start, start + STORED_CHUNK_BYTES));
    }
    return;
  }
  if (entry.method !== DEFLATED) {
    throw new ReaderError('unsupported_media', 'This workbook uses an unsupported zip compression.');
  }
  const inflate = new Inflate((chunk) => {
    if (!isStopped()) sink(chunk);
  });
  for (let start = 0; start < compressed.byteLength && !isStopped(); start += COMPRESSED_CHUNK_BYTES) {
    const end = start + COMPRESSED_CHUNK_BYTES;
    inflate.push(compressed.subarray(start, end), end >= compressed.byteLength);
  }
}

/**
 * Opens an `.xlsx` archive without inflating anything: it refuses an archive over `maxCompressedBytes`,
 * and one whose central directory declares more than `maxInflatedBytes` in total, before any entry is
 * inflated. Declared sizes are not trusted afterwards either: `streamText` counts the bytes it really
 * inflates (into `work.inflatedBytes`) and stops with `too_large` as soon as an entry exceeds its declared
 * size or the total exceeds the limit.
 *
 * @example
 * ```ts
 * const archive = openZip(new Uint8Array(buffer), DEFAULT_CAPS, newReadWork());
 * archive.names.has('xl/workbook.xml'); // true
 * ```
 */
export function openZip(bytes: Uint8Array, caps: ReaderCaps, work: ReadWork): ZipArchive {
  if (bytes.byteLength > caps.maxCompressedBytes) {
    throw new ReaderError('too_large', `This workbook is over the ${caps.maxCompressedBytes}-byte limit.`);
  }
  const entries = readCentralDirectory(bytes, caps);
  const streamText = (name: string, onText: (text: string) => boolean): void => {
    const entry = entries.get(name);
    if (!entry) throw new ReaderError('load_error', `This workbook is missing its ${name} part.`);
    const decoder = new TextDecoder();
    let stopped = false;
    const sink = countingSink(entry, caps, work, (chunk) => {
      stopped = !onText(decoder.decode(chunk, { stream: true }));
    });
    inflateEntry(bytes, entry, sink, () => stopped);
    if (!stopped) onText(decoder.decode());
  };
  return { names: new Set(entries.keys()), streamText };
}
