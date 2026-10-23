import { Unzip, UnzipInflate, Zip, ZipPassThrough } from 'fflate';

/**
 * The most work a `.docx` may ask for.
 *
 * - Unzipped: 200 MiB in all, of which 16 MiB of XML (any file whose content starts with `<`, whatever its
 *   name), in 10,000 files (duplicate names count), with `w:num` × `w:lvl` tags (multiplied out by
 *   docx-preview while parsing numbering) at most 4 million; opening and closing tags both count, so that is
 *   about a million list levels.
 * - Rendered: 5,000 relationships; 200,000 elements, counting each header and footer once per page and each
 *   footnote and endnote once per reference; 25 million relationship lookups (docx-preview finds each link's
 *   and image's relationship by a linear search); and 64 MiB of images as `data:` URLs, each image counted
 *   once per place it is shown.
 *
 * Larger documents are refused before the work they would cost.
 *
 * @example
 * ```ts
 * repackWithinLimits(bytes, { ...DOCX_LIMITS, markupBytes: 1024 * 1024 });
 * ```
 */
export const DOCX_LIMITS: {
  inflatedBytes: number;
  markupBytes: number;
  entries: number;
  numberingLevels: number;
  relationships: number;
  elements: number;
  relationshipLookups: number;
  imageUrlBytes: number;
} = {
  inflatedBytes: 200 * 1024 * 1024,
  markupBytes: 16 * 1024 * 1024,
  entries: 10_000,
  numberingLevels: 4_000_000,
  relationships: 5_000,
  elements: 200_000,
  relationshipLookups: 25_000_000,
  imageUrlBytes: 64 * 1024 * 1024,
};

type Limits = typeof DOCX_LIMITS;

const INPUT_SLICE_BYTES = 16 * 1024;
const LEADING_WHITESPACE_OR_BOM: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf]);
const LESS_THAN = 0x3c;
const NUMBERING_TAG = /[<:](num|lvl)[\s>/]/g;
const DOCUMENT_TYPE_DECLARATION = /<!doctype/i;
const CARRIED_CHARACTERS = '<!doctype'.length - 1;
const PLAIN_HTML_DOCTYPE_AT_START = /^[\t\n\f\r ]*<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/i;
const START_CHARACTERS = 256;
const COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Thrown when a document is over one of `DOCX_LIMITS`.
 *
 * @example
 * ```ts
 * if (thrown instanceof DocumentLimitExceeded) onError(viewerError('too_large', thrown));
 * ```
 */
export class DocumentLimitExceeded extends Error {}

/**
 * Thrown for a file stored as an OLE compound file, which is how Word saves a password-protected `.docx`;
 * the viewer shows it as `password_protected`. (A legacy `.doc` renamed to `.docx` is one too.)
 *
 * @example
 * ```ts
 * const kind = thrown instanceof EncryptedDocument ? 'password_protected' : 'load_error';
 * ```
 */
export class EncryptedDocument extends Error {}

/**
 * Throws `DocumentLimitExceeded` when `count` is over `limit`, naming `what` was counted.
 *
 * @example
 * ```ts
 * refuseOver(DOCX_LIMITS.elements, elementCount, 'elements');
 * ```
 */
export function refuseOver(limit: number, count: number, what: string): void {
  if (count > limit) throw new DocumentLimitExceeded(`more than ${limit} ${what}`);
}

interface MarkupCounts {
  bytes: number;
  numberingTags: { num: number; lvl: number };
}

function refuseDocumentType(text: string): void {
  if (!DOCUMENT_TYPE_DECLARATION.test(text)) return;
  throw new Error('A part declares a document type, which Word documents never do');
}

function countNumberingTags(text: string, carried: number, counts: MarkupCounts, limits: Limits): void {
  for (const match of text.matchAll(NUMBERING_TAG)) {
    if (match.index + match[0].length > carried) counts.numberingTags[match[1] as 'num' | 'lvl']++;
  }
  const { num, lvl } = counts.numberingTags;
  refuseOver(limits.numberingLevels, num * lvl, 'numbering levels');
}

const withoutPlainHtmlDoctype = (start: string): string => start.replace(PLAIN_HTML_DOCTYPE_AT_START, '');

function markupCounter(counts: MarkupCounts, limits: Limits): (chunk: Uint8Array, final: boolean) => void {
  const decoder = new TextDecoder();
  let isMarkup: boolean | undefined;
  let start: string | undefined = '';
  let tail = '';
  return (chunk, final) => {
    if (isMarkup === undefined) {
      const first = chunk.find((byte) => !LEADING_WHITESPACE_OR_BOM.has(byte));
      if (first !== undefined) isMarkup = first === LESS_THAN;
    }
    if (isMarkup === false) return;
    counts.bytes += chunk.length;
    refuseOver(limits.markupBytes, counts.bytes, 'bytes of XML');
    let decoded = decoder.decode(chunk, { stream: !final });
    if (start !== undefined) {
      start += decoded;
      if (start.length < START_CHARACTERS && !final) return;
      decoded = withoutPlainHtmlDoctype(start);
      start = undefined;
    }
    const text = tail + decoded;
    refuseDocumentType(text);
    countNumberingTags(text, tail.length, counts, limits);
    tail = text.slice(-CARRIED_CHARACTERS);
  };
}

/**
 * A `.docx` repacked by `repackWithinLimits`: the stored archive and the size of each of its files.
 *
 * @example
 * ```ts
 * const { archive, fileSizes } = repackWithinLimits(bytes);
 * ```
 */
export interface RepackedDocx {
  archive: Blob;
  fileSizes: Map<string, number>;
}

/**
 * Unzips `zip` a slice at a time and zips each file again, uncompressed, as its bytes arrive, so the engine
 * reads only what was counted here. An XML part that declares a document type (`<!DOCTYPE`, in any case,
 * which OOXML never uses and whose entities could expand into millions of elements) throws an `Error` (a
 * `load_error` for the viewer), before anything parses it. The one exception (Ruling P4-14) is a part that
 * starts, within its first 256 characters, with exactly `<!DOCTYPE html>` (any case, ASCII whitespace
 * inside, no identifier and no internal subset, so no entities), as embedded HTML chunks do. Bytes are
 * counted as they are inflated (the sizes the headers declare are not trusted) and XML is recognized by its
 * content, so an archive over `limits` throws `DocumentLimitExceeded` after inflating little more than the
 * limit; one whose directory disagrees with its file headers is read the same way by both. An OLE compound
 * file (an encrypted document) throws `EncryptedDocument` before anything is unzipped.
 *
 * @example
 * ```ts
 * const parsed = await parseAsync(repackWithinLimits(new Uint8Array(buffer)).archive);
 * ```
 */
export function repackWithinLimits(zip: Uint8Array, limits: Limits = DOCX_LIMITS): RepackedDocx {
  if (COMPOUND_FILE_SIGNATURE.every((byte, index) => zip[index] === byte)) {
    throw new EncryptedDocument('An OLE compound file: an encrypted document');
  }
  const storedChunks: Uint8Array<ArrayBuffer>[] = [];
  const repacked = new Zip((error, chunk) => {
    if (error) throw error;
    storedChunks.push(chunk);
  });
  const fileSizes = new Map<string, number>();
  const markup: MarkupCounts = { bytes: 0, numberingTags: { num: 0, lvl: 0 } };
  let entries = 0;
  let inflatedBytes = 0;
  const unzipper = new Unzip((entry) => {
    refuseOver(limits.entries, ++entries, 'files');
    const countMarkup = markupCounter(markup, limits);
    const copy = new ZipPassThrough(entry.name);
    repacked.add(copy);
    fileSizes.set(entry.name, 0);
    entry.ondata = (error, chunk, final) => {
      if (error) throw error;
      inflatedBytes += chunk.length;
      refuseOver(limits.inflatedBytes, inflatedBytes, 'bytes once unzipped');
      fileSizes.set(entry.name, (fileSizes.get(entry.name) ?? 0) + chunk.length);
      countMarkup(chunk, final);
      copy.push(chunk, final);
    };
    entry.start();
  });
  unzipper.register(UnzipInflate);
  for (let offset = 0; offset < zip.length; offset += INPUT_SLICE_BYTES) {
    unzipper.push(zip.subarray(offset, offset + INPUT_SLICE_BYTES), offset + INPUT_SLICE_BYTES >= zip.length);
  }
  repacked.end();
  return { archive: new Blob(storedChunks), fileSizes };
}
