import { afterEach, beforeEach, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { CSRF_HEADER } from '@scope/core';
import type { Entry } from '@scope/core';
import { createFileHandler, type FileStore } from '../src';

let tz: string | undefined;
beforeEach(() => {
  tz = process.env.TZ;
});
afterEach(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

const zipWithMtime = async (mtimeMs: number): Promise<string[]> => {
  const dir: Entry = { path: 'd', name: 'd', kind: 'directory', size: null, mtimeMs };
  const f: Entry = { path: 'd/f', name: 'f', kind: 'file', size: 0, mtimeMs };
  const store = {
    stat: async (p: string) => (p === 'd' ? dir : null),
    list: async () => [f],
    read: async () => ({ body: new Blob([]).stream() as ReadableStream<Uint8Array>, size: 0, entry: f }),
  } as unknown as FileStore;
  const h = createFileHandler({ store, authorize: () => true });
  const res = await h(
    new Request('http://t/api/files/download', {
      method: 'POST',
      headers: { [CSRF_HEADER]: '1' },
      body: JSON.stringify({ paths: ['d'] }),
    }),
  );
  expect(res.status).toBe(200);
  return Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer()))).sort();
};

// fflate validates the *local* calendar year, so the DOS range must be tested in local time.
it('a 1980 UTC mtime that is still 1979 locally does not truncate the zip (America/New_York)', async () => {
  process.env.TZ = 'America/New_York';
  expect(new Date(Date.UTC(1980, 0, 1)).getFullYear()).toBe(1979);
  expect(await zipWithMtime(Date.UTC(1980, 0, 1))).toEqual(['d/', 'd/f']);
});

it('a 2099 UTC mtime that is already 2100 locally does not truncate the zip (Pacific/Auckland)', async () => {
  process.env.TZ = 'Pacific/Auckland';
  const ms = Date.UTC(2099, 11, 31, 12);
  expect(new Date(ms).getFullYear()).toBe(2100);
  expect(await zipWithMtime(ms)).toEqual(['d/', 'd/f']);
});

it('epoch, negative and NaN mtimes also stream', async () => {
  for (const ms of [0, -1, Number.NaN, 1e18]) expect(await zipWithMtime(ms)).toEqual(['d/', 'd/f']);
});
