import type { PptxFiles, PresentationData } from '@aiden0z/pptx-renderer';
import JSZip from 'jszip';

const MEBIBYTE = 1024 * 1024;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const CENTRAL_DIRECTORY_RECORD = 0x02014b50;
const CENTRAL_DIRECTORY_RECORD_BYTES = 46;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const LETTER_P = 0x50;

/**
 * The most work one presentation may cost before it is refused as too large to preview.
 *
 * - `centralDirectoryRecords`: central directory records, walked from where JSZip starts reading them, the
 *   way it reads them (each one costs the parser an object), before any zip parser runs.
 * - `entries`, `entryBytes`, `totalBytes`: files in the archive, and bytes each one and all of them inflate
 *   to, counted while inflating (the sizes an archive declares are not trusted). The same numbers as the
 *   renderer's `RECOMMENDED_ZIP_LIMITS`, which it checks against the declared sizes.
 * - `slides`: slides the presentation lists.
 * - `slideSidePx`: the largest slide width or height, 56 inches at 96 px per inch (the format's maximum).
 * - `slideWeight`, `textBodyWeight`: the work one slide may cost to draw, in XML elements of its slide,
 *   layout and master and of each chart or diagram it shows (once per place it shows them), where each text
 *   body also weighs `textBodyWeight`. Measured on Chromium: a plain element costs about 0.003 ms, but each
 *   text body costs about 6e-5 ms per element on the slide (the renderer lays text out against the whole
 *   slide), so text bodies times elements is what grows; 2,200 text shapes on a master took 3 s per slide.
 *   Within 12,000, with each text body weighing 3 more (a text shape is then about 21), the worst mixes
 *   measured took 0.2 to 0.4 s, and at the 1.4 ms per text shape seen on a slower run about 0.8 s.
 * - `slideTabs`: tab characters in the text one slide shows (the renderer lays each tab out separately,
 *   which grows about cubically: 2,000 took 6.7 s).
 * - `slideMediaBytes`: bytes of embedded media one slide shows, once per place it shows them.
 * - `slideEffectPixels`: pixels of the images one slide shows with a duotone, luminance or black-and-white
 *   effect, once per place (the renderer copies each such image to a canvas at its full size).
 * - `slideChartAreas`: chart area one slide shows, in slide areas (each chart's frame counted no larger
 *   than the slide, which is also the most it is drawn at).
 *
 * @example
 * ```ts
 * await assertArchiveWithinLimits(bytes, signal, { ...PPTX_LIMITS, entryBytes: 1024 });
 * ```
 */
export const PPTX_LIMITS: {
  centralDirectoryRecords: number;
  entries: number;
  entryBytes: number;
  totalBytes: number;
  slides: number;
  slideSidePx: number;
  slideWeight: number;
  textBodyWeight: number;
  slideTabs: number;
  slideMediaBytes: number;
  slideEffectPixels: number;
  slideChartAreas: number;
} = {
  centralDirectoryRecords: 8000,
  entries: 4000,
  entryBytes: 32 * MEBIBYTE,
  totalBytes: 256 * MEBIBYTE,
  slides: 5000,
  slideSidePx: 5376,
  slideWeight: 12_000,
  textBodyWeight: 3,
  slideTabs: 500,
  slideMediaBytes: 128 * MEBIBYTE,
  slideEffectPixels: 25_000_000,
  slideChartAreas: 4,
};

/**
 * Thrown when a presentation would cost more work to open than `PPTX_LIMITS` allows; the viewer shows it as
 * `too_large`.
 *
 * @example
 * ```ts
 * const kind = thrown instanceof DocumentLimitExceeded ? 'too_large' : 'load_error';
 * ```
 */
export class DocumentLimitExceeded extends Error {}

/**
 * Thrown for a file stored as an OLE compound file, which is how PowerPoint saves a password-protected
 * `.pptx`; the viewer shows it as `password_protected`. (A legacy `.ppt` renamed to `.pptx` is one too.)
 *
 * @example
 * ```ts
 * const kind = thrown instanceof EncryptedPresentation ? 'password_protected' : 'load_error';
 * ```
 */
export class EncryptedPresentation extends Error {}

type StreamingZipObject = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

function lastIndexOfSignature(bytes: Uint8Array, view: DataView, signature: number): number {
  if (bytes.length < END_OF_CENTRAL_DIRECTORY_BYTES) return -1;
  let at = bytes.lastIndexOf(LETTER_P, bytes.length - 4);
  while (at >= 0) {
    if (view.getUint32(at, true) === signature) return at;
    if (at === 0) return -1;
    at = bytes.lastIndexOf(LETTER_P, at - 1);
  }
  return -1;
}

const isZip64 = (view: DataView, end: number): boolean =>
  [4, 6, 8, 10].some((offset) => view.getUint16(end + offset, true) === ZIP64_MARKER_16) ||
  [12, 16].some((offset) => view.getUint32(end + offset, true) === ZIP64_MARKER_32);

function firstCentralDirectoryRecord(bytes: Uint8Array, view: DataView): number {
  const end = lastIndexOfSignature(bytes, view, END_OF_CENTRAL_DIRECTORY);
  if (end < 0 || end + END_OF_CENTRAL_DIRECTORY_BYTES > bytes.length) {
    throw new Error('Not a zip archive: it has no end of central directory record');
  }
  if (isZip64(view, end)) throw new Error('ZIP64 archives are not read; a presentation never needs one');
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  const prependedBytes = end - (offset + size);
  if (prependedBytes < 0) throw new Error('Corrupted zip archive: its central directory overruns the file');
  return offset + prependedBytes;
}

function centralDirectoryRecordsUpTo(bytes: Uint8Array, most: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  let at = firstCentralDirectoryRecord(bytes, view);
  while (count <= most && at + CENTRAL_DIRECTORY_RECORD_BYTES <= bytes.length) {
    if (view.getUint32(at, true) !== CENTRAL_DIRECTORY_RECORD) break;
    count++;
    const variableBytes = [28, 30, 32].reduce((total, field) => total + view.getUint16(at + field, true), 0);
    at += CENTRAL_DIRECTORY_RECORD_BYTES + variableBytes;
  }
  return count;
}

function inflateCounting(
  file: StreamingZipObject,
  countInflated: (byteCount: number) => DocumentLimitExceeded | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = file.internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        const refusal = countInflated(chunk.length);
        if (!refusal) return;
        stream.pause();
        reject(refusal);
      })
      .on('error', reject)
      .on('end', resolve)
      .resume();
  });
}

const overLimit = (limit: number, count: number, what: string): DocumentLimitExceeded | undefined =>
  count > limit ? new DocumentLimitExceeded(`${what}: ${count} is over the limit of ${limit}`) : undefined;

function refuseOver(limit: number, count: number, what: string): void {
  const refusal = overLimit(limit, count, what);
  if (refusal) throw refusal;
}

/**
 * Inflates every file of a `.pptx` archive once, counting the bytes as they come out, and rejects with
 * `DocumentLimitExceeded` as soon as a file or the archive goes over `limits`, so an inflation bomb costs at
 * most the limit plus one chunk. It reads the archive with JSZip, the parser the renderer uses, so it counts
 * exactly the files the renderer will inflate. Before that, the central directory records are walked from
 * the end of central directory record the way JSZip walks them (it reads every record it finds, whatever
 * count the archive declares), so the parser never builds more than `centralDirectoryRecords` entries; and
 * an OLE compound file (an encrypted presentation) rejects with `EncryptedPresentation`. Checks `signal`
 * between files.
 *
 * @example
 * ```ts
 * await assertArchiveWithinLimits(new Uint8Array(buffer), controller.signal);
 * ```
 */
export async function assertArchiveWithinLimits(
  bytes: Uint8Array,
  signal: AbortSignal,
  limits: typeof PPTX_LIMITS = PPTX_LIMITS,
): Promise<void> {
  if (COMPOUND_FILE_SIGNATURE.every((byte, offset) => bytes[offset] === byte)) {
    throw new EncryptedPresentation('The file is an OLE compound file: an encrypted presentation');
  }
  const records = centralDirectoryRecordsUpTo(bytes, limits.centralDirectoryRecords);
  refuseOver(limits.centralDirectoryRecords, records, 'Central directory records');
  const archive = await JSZip.loadAsync(bytes);
  signal.throwIfAborted();
  const files = Object.values(archive.files).filter((file) => !file.dir) as StreamingZipObject[];
  refuseOver(limits.entries, files.length, 'Files in the archive');
  let totalBytes = 0;
  for (const file of files) {
    let fileBytes = 0;
    await inflateCounting(file, (byteCount) => {
      fileBytes += byteCount;
      totalBytes += byteCount;
      return (
        overLimit(limits.entryBytes, fileBytes, `Inflated bytes of ${file.name}`) ??
        overLimit(limits.totalBytes, totalBytes, 'Inflated bytes of the archive')
      );
    });
    signal.throwIfAborted();
  }
}

const DOCUMENT_TYPE_DECLARATION = '<!DOCTYPE';
const SLIDE_ID_ELEMENT = /<(?:[\w.-]+:)?sldId[\s/>]/g;

function slideIdsUpTo(presentationXml: string, most: number): number {
  let count = 0;
  SLIDE_ID_ELEMENT.lastIndex = 0;
  while (count <= most && SLIDE_ID_ELEMENT.exec(presentationXml)) count++;
  return count;
}

function* markupOf(files: PptxFiles): Generator<string> {
  for (const value of Object.values(files)) {
    if (typeof value === 'string') yield value;
    else if (value instanceof Map) {
      for (const part of value.values()) if (typeof part === 'string') yield part;
    }
  }
}

/**
 * Checks the unpacked parts of a presentation before the renderer builds it: no part may declare a document
 * type (OOXML never does, and a declaration's entities could make the XML parser expand a few bytes into
 * millions of elements), which throws an `Error`; and the presentation may list at most `slides` slides
 * (each one costs the builder a parse of its relationships, however often it is listed), which throws
 * `DocumentLimitExceeded`.
 *
 * @example
 * ```ts
 * assertPartsWithinLimits(await parseZip(buffer, RECOMMENDED_ZIP_LIMITS));
 * ```
 */
export function assertPartsWithinLimits(files: PptxFiles, limits: typeof PPTX_LIMITS = PPTX_LIMITS): void {
  for (const markup of markupOf(files)) {
    if (markup.includes(DOCUMENT_TYPE_DECLARATION)) {
      throw new Error('A part declares a document type, which presentations never do');
    }
  }
  refuseOver(limits.slides, slideIdsUpTo(files.presentation, limits.slides), 'Slides');
}

/**
 * Throws `DocumentLimitExceeded` when the presentation's slides are wider or taller than `slideSidePx`, or
 * not a positive size.
 *
 * @example
 * ```ts
 * assertSlideSizeWithinLimits(buildPresentation(files, { lazySlides: true }));
 * ```
 */
export function assertSlideSizeWithinLimits(
  presentation: Pick<PresentationData, 'width' | 'height'>,
  limits: typeof PPTX_LIMITS = PPTX_LIMITS,
): void {
  for (const side of [presentation.width, presentation.height]) {
    if (!(side > 0)) throw new DocumentLimitExceeded(`A slide side of ${side} px is not a size`);
    refuseOver(limits.slideSidePx, side, 'Slide side in px');
  }
}
