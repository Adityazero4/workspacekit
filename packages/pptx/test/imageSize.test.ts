import { expect, test } from 'vitest';
import { imagePixelsOf } from '../src/imageSize';
import { pngOfSize } from './fixtures/pptx';

const jpeg = (width: number, height: number): Uint8Array =>
  Uint8Array.of(
    ...[0xff, 0xd8],
    ...[0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46],
    ...[0xff, 0xdb, 0x00, 0x04, 0x00, 0x00],
    ...[0xff, 0xc2, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01],
    ...[0xff, 0xd9],
  );

test('PNG pixels come from its header', () => {
  expect(imagePixelsOf(pngOfSize(4000, 3000))).toBe(12_000_000);
});

test('GIF pixels come from its logical screen', () => {
  expect(imagePixelsOf(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x27, 0x20, 0x03))).toBe(
    10_000 * 800,
  );
});

test('JPEG pixels come from the first frame header, past other segments', () => {
  expect(imagePixelsOf(jpeg(6000, 5000))).toBe(30_000_000);
});

test('an unknown format or an unreadable header counts as infinitely many pixels', () => {
  expect(imagePixelsOf(Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(
    Infinity,
  );
  expect(imagePixelsOf(jpeg(10, 10).subarray(0, 12))).toBe(Infinity);
  expect(imagePixelsOf(Uint8Array.of(0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0))).toBe(Infinity);
});
