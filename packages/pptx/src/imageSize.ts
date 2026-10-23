const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38];
const PNG_HEADER_BYTES = 24;
const GIF_HEADER_BYTES = 10;
const JPEG_MARKER = 0xff;
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_STANDALONE_MARKERS: ReadonlySet<number> = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
]);
const JPEG_NOT_FRAME_MARKERS: ReadonlySet<number> = new Set([0xc4, 0xc8, 0xcc]);

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, offset) => bytes[offset] === byte);

const isJpegStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && !JPEG_NOT_FRAME_MARKERS.has(marker);

function jpegPixels(bytes: Uint8Array, view: DataView): number {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== JPEG_MARKER) return Number.POSITIVE_INFINITY;
    const marker = bytes[at + 1]!;
    if (marker === JPEG_MARKER) at++;
    else if (isJpegStartOfFrame(marker)) return view.getUint16(at + 5) * view.getUint16(at + 7);
    else if (JPEG_STANDALONE_MARKERS.has(marker)) at += 2;
    else at += 2 + view.getUint16(at + 2);
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The pixels an image decodes to (width times height), read from its header without decoding it: PNG, GIF
 * and JPEG (walking its segments to the first frame header). Any other format, or a header that cannot be
 * read, counts as `Infinity`, so a limit on pixels refuses what it cannot measure.
 *
 * @example
 * ```ts
 * imagePixelsOf(pngBytes); // 16000000 for a 4000 × 4000 PNG
 * ```
 */
export function imagePixelsOf(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (startsWith(bytes, PNG_SIGNATURE) && bytes.length >= PNG_HEADER_BYTES) {
    return view.getUint32(16) * view.getUint32(20);
  }
  if (startsWith(bytes, GIF_SIGNATURE) && bytes.length >= GIF_HEADER_BYTES) {
    return view.getUint16(6, true) * view.getUint16(8, true);
  }
  if (bytes[0] === JPEG_MARKER && bytes[1] === JPEG_START_OF_IMAGE) return jpegPixels(bytes, view);
  return Number.POSITIVE_INFINITY;
}
