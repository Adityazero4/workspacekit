import { extname } from '@workspacekit/core';

const PLAIN_TEXT = 'text/plain; charset=utf-8';
const OCTET_STREAM = 'application/octet-stream';

const EXTENSIONS_BY_CONTENT_TYPE: ReadonlyArray<[string, string]> = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/bmp', 'bmp'],
  ['image/x-icon', 'ico'],
  ['image/svg+xml', 'svg'],
  ['image/tiff', 'tif tiff'],
  ['video/mp4', 'mp4 m4v'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg oga'],
  ['audio/flac', 'flac'],
  ['audio/aac', 'aac'],
  ['audio/mp4', 'm4a'],
  ['application/pdf', 'pdf'],
  [
    PLAIN_TEXT,
    'txt md markdown csv tsv json yaml yml toml xml log js mjs cjs ts tsx jsx py go rs java c cpp h css sh',
  ],
];

const CONTENT_TYPE_BY_EXTENSION = new Map(
  EXTENSIONS_BY_CONTENT_TYPE.flatMap(([type, extensions]) =>
    extensions.split(' ').map((extension): [string, string] => [extension, type]),
  ),
);

/**
 * The `Content-Type` served for a file name. Never `text/html`, because a served page would run in the app's
 * origin: source and markup files are plain text, and anything not listed is `application/octet-stream`.
 *
 * @example
 * contentTypeFor('notes.md'); // 'text/plain; charset=utf-8'
 */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPE_BY_EXTENSION.get(extname(name)) ?? OCTET_STREAM;
}

/**
 * A `Content-Disposition: attachment` value with an RFC 5987 `filename*`, also escaping the characters
 * `encodeURIComponent` leaves alone.
 *
 * @example
 * attachmentDisposition("it's.txt"); // "attachment; filename*=UTF-8''it%27s.txt"
 */
export function attachmentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * Headers for a downloaded or read file: its type, an attachment disposition, `nosniff` and a sandboxing CSP.
 *
 * @example
 * new Response(body, { headers: fileHeaders('report.pdf', contentTypeFor('report.pdf')) });
 */
export function fileHeaders(name: string, type: string): Headers {
  return new Headers({
    'Content-Type': type,
    'Content-Disposition': attachmentDisposition(name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
}

/**
 * An inclusive byte range, as in HTTP `Range`.
 *
 * @example
 * const range: ByteRange = { start: 0, end: 1023 };
 */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range` header against a file of `size` bytes. `undefined` means "ignore the header
 * and serve the whole file" (a multi-range or malformed header); `'unsatisfiable'` means answer 416.
 *
 * @example
 * parseRange('bytes=0-99', 1000); // { start: 0, end: 99 }
 * parseRange('bytes=-100', 1000); // { start: 900, end: 999 }
 */
export function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffixLength = Number(last);
    return suffixLength === 0 || size === 0
      ? 'unsatisfiable'
      : { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}
