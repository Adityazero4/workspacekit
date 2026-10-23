import { strToU8, zipSync } from 'fflate';
import JSZip from 'jszip';
import { afterEach, expect, test, vi } from 'vitest';
import {
  assertArchiveWithinLimits,
  DocumentLimitExceeded,
  EncryptedPresentation,
  PPTX_LIMITS,
} from '../src/limits';
import { inflationBomb, pptxBytes, textSlides, withDeclaredSize } from './fixtures/pptx';

const MEBIBYTE = 1024 * 1024;
const LARGEST_INFLATED_CHUNK = 17 * MEBIBYTE;
const BOMB = 'ppt/media/bomb.bin';
const neverAborted = new AbortController().signal;

type StreamHelper = JSZip.JSZipStreamHelper<Uint8Array>;
type StreamingPrototype = { internalStream: (type: 'uint8array') => StreamHelper };

async function countInflatedBytes(): Promise<{ total: () => number }> {
  const sample = await JSZip.loadAsync(zipSync({ 'a.txt': strToU8('a') }));
  const prototype = Object.getPrototypeOf(sample.files['a.txt']) as StreamingPrototype;
  const original = prototype.internalStream;
  let total = 0;
  vi.spyOn(prototype, 'internalStream').mockImplementation(function (this: unknown, type) {
    return original.call(this, type).on('data', (chunk) => void (total += chunk.length));
  });
  return { total: () => total };
}

afterEach(() => vi.restoreAllMocks());

test('a well-formed deck passes, inflating each file once', async () => {
  const counted = await countInflatedBytes();
  const bytes = pptxBytes({ slides: textSlides(3) });
  await expect(assertArchiveWithinLimits(bytes, neverAborted)).resolves.toBeUndefined();
  expect(counted.total()).toBeGreaterThan(0);
  expect(counted.total()).toBeLessThan(64 * 1024);
});

test.each([
  ['honest', (archive: Uint8Array) => archive],
  ['lying (it declares 1,000 bytes)', (archive: Uint8Array) => withDeclaredSize(archive, BOMB, 1000)],
])(
  'zip limits reject a crafted inflation bomb quickly: 256 MiB in one %s file stops after the 32 MiB cap',
  async (_kind, declare) => {
    const counted = await countInflatedBytes();
    const bomb = declare(inflationBomb(256));
    expect(bomb.length).toBeLessThan(MEBIBYTE);

    const refusal = assertArchiveWithinLimits(bomb, neverAborted);

    await expect(refusal).rejects.toBeInstanceOf(DocumentLimitExceeded);
    await expect(refusal).rejects.toThrow(/ppt\/media\/bomb\.bin/);
    expect(counted.total()).toBeGreaterThan(PPTX_LIMITS.entryBytes);
    expect(counted.total()).toBeLessThanOrEqual(PPTX_LIMITS.entryBytes + LARGEST_INFLATED_CHUNK);
  },
  30_000,
);

test('the archive total is counted across files', async () => {
  const counted = await countInflatedBytes();
  const files = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => [`ppt/media/part${index}.bin`, new Uint8Array(MEBIBYTE)]),
  );
  const archive = zipSync(files);
  const limits = { ...PPTX_LIMITS, totalBytes: 4 * MEBIBYTE };
  await expect(assertArchiveWithinLimits(archive, neverAborted, limits)).rejects.toThrow(
    /Inflated bytes of the archive/,
  );
  expect(counted.total()).toBeLessThanOrEqual(5 * MEBIBYTE);
});

test('too many central directory records are refused before the zip parser runs', async () => {
  const loadAsync = vi.spyOn(JSZip, 'loadAsync');
  const files = Object.fromEntries(
    Array.from({ length: 9000 }, (_, index) => [`f${index}`, new Uint8Array()]),
  );
  await expect(assertArchiveWithinLimits(zipSync(files), neverAborted)).rejects.toThrow(
    /Central directory records/,
  );
  expect(loadAsync).not.toHaveBeenCalled();
});

test('more files than the entry limit are refused before any is inflated', async () => {
  const counted = await countInflatedBytes();
  const files = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`f${index}`, strToU8('x')]));
  const limits = { ...PPTX_LIMITS, entries: 10 };
  await expect(assertArchiveWithinLimits(zipSync(files), neverAborted, limits)).rejects.toThrow(
    /Files in the archive/,
  );
  expect(counted.total()).toBe(0);
});

test('an abort stops the pass between files', async () => {
  const counted = await countInflatedBytes();
  const controller = new AbortController();
  controller.abort();
  const pass = assertArchiveWithinLimits(pptxBytes({ slides: textSlides(2) }), controller.signal);
  await expect(pass).rejects.toThrow();
  expect(counted.total()).toBe(0);
});

function endOfCentralDirectory(archive: Uint8Array): DataView {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let at = archive.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      return new DataView(archive.buffer, archive.byteOffset + at, 22);
    }
  }
  throw new Error('no end of central directory record');
}

test('records are walked as JSZip walks them: an archive declaring 10 records but holding 9,000 is refused unparsed', async () => {
  const loadAsync = vi.spyOn(JSZip, 'loadAsync');
  const files = Object.fromEntries(
    Array.from({ length: 9000 }, (_, index) => [`f${index}`, new Uint8Array()]),
  );
  const archive = zipSync(files);
  const end = endOfCentralDirectory(archive);
  end.setUint16(8, 10, true);
  end.setUint16(10, 10, true);
  await expect(assertArchiveWithinLimits(archive, neverAborted)).rejects.toThrow(/Central directory records/);
  expect(loadAsync).not.toHaveBeenCalled();
});

test('a deck at the record limit passes the walk', async () => {
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`f${index}`, strToU8('x')]));
  const limits = { ...PPTX_LIMITS, centralDirectoryRecords: 50 };
  await expect(assertArchiveWithinLimits(zipSync(files), neverAborted, limits)).resolves.toBeUndefined();
  const oneMore = { ...files, f50: strToU8('x') };
  await expect(assertArchiveWithinLimits(zipSync(oneMore), neverAborted, limits)).rejects.toThrow(
    /Central directory records/,
  );
});

test('an OLE compound file (an encrypted presentation) is refused as encrypted, unparsed', async () => {
  const loadAsync = vi.spyOn(JSZip, 'loadAsync');
  const compound = new Uint8Array(1024);
  compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await expect(assertArchiveWithinLimits(compound, neverAborted)).rejects.toBeInstanceOf(
    EncryptedPresentation,
  );
  expect(loadAsync).not.toHaveBeenCalled();
});

test('ZIP64 markers and archives without an end record are refused before the parser runs', async () => {
  const loadAsync = vi.spyOn(JSZip, 'loadAsync');
  const archive = pptxBytes({ slides: textSlides(1) });
  endOfCentralDirectory(archive).setUint16(10, 0xffff, true);
  await expect(assertArchiveWithinLimits(archive, neverAborted)).rejects.toThrow(/ZIP64/);
  await expect(assertArchiveWithinLimits(new Uint8Array(100), neverAborted)).rejects.toThrow(/Not a zip/);
  expect(loadAsync).not.toHaveBeenCalled();
});
