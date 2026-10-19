import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFsError, type FsErrorKind } from '../../src/errors';
import type { ChangeEvent, FileSystemAdapter, UploadTransport } from '../../src/types';

type Full = Required<Omit<FileSystemAdapter, 'url' | 'download' | 'upload'>> & {
  upload: Required<UploadTransport>;
};
type Make = () => Promise<{ adapter: FileSystemAdapter; cleanup(): Promise<void> }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const signal = (): AbortSignal => new AbortController().signal;

async function expectKind(p: Promise<unknown>, kind: FsErrorKind): Promise<void> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isFsError(e) ? e.kind : e).toBe(kind);
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// \u escapes keep the NFC/NFD forms unambiguous in source.
const NFC_NAME = 'dir with space/résumé #1 100%?+.md';
const NFD_NAME = 'dir with space/résumé #1 100%?+.md';

/**
 * Runs against any FileSystemAdapter, including a client talking to a real server.
 * Seeds data only through adapter methods and never assumes watch delivery is synchronous.
 */
export function runAdapterContract(name: string, make: Make): void {
  describe(`adapter contract: ${name}`, () => {
    let fs: Full;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      const m = await make();
      fs = m.adapter as Full;
      cleanup = m.cleanup;
    });
    afterEach(() => cleanup());

    const paths = async (p: string, depth: number): Promise<string[]> =>
      (await fs.list(p, { depth })).map((e) => e.path).sort();
    const text = (p: string): Promise<string> => fs.read(p, 'text');
    const putBytes = (p: string, bytes: Uint8Array<ArrayBuffer>) =>
      fs.upload.direct(p, new Blob([bytes]), { signal: signal() });

    it('list depth 1 and 2', async () => {
      await fs.write('a/b/c.txt', 'c');
      await fs.write('a/d.txt', 'd');
      const d1 = await fs.list('', { depth: 1 });
      expect(d1.map((e) => e.path)).toEqual(['a']);
      const d2 = await fs.list('', { depth: 2 });
      expect(d2.map((e) => e.path).sort()).toEqual(['a', 'a/b', 'a/d.txt']);
      for (const e of d2) {
        expect(e.kind).toBe(e.path === 'a/d.txt' ? 'file' : 'directory');
        expect(typeof e.mtimeMs).toBe('number');
        expect(e.name).toBe(e.path.slice(e.path.lastIndexOf('/') + 1));
      }
    });

    it('read text, blob, arrayBuffer', async () => {
      await fs.write('t.txt', 'héllo');
      expect(await fs.read('t.txt', 'text')).toBe('héllo');
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await putBytes('b.bin', bytes);
      const blob = await fs.read('b.bin', 'blob');
      expect(same(new Uint8Array(await blob.arrayBuffer()), bytes)).toBe(true);
      expect(same(new Uint8Array(await fs.read('b.bin', 'arrayBuffer')), bytes)).toBe(true);
      await putBytes('empty.bin', new Uint8Array(0));
      expect((await fs.read('empty.bin', 'arrayBuffer')).byteLength).toBe(0);
      expect((await fs.read('empty.bin', 'blob')).size).toBe(0);
      expect(await fs.read('empty.bin', 'text')).toBe('');
      await expectKind(fs.read('missing.txt', 'text'), 'not_found');
    });

    it('stat', async () => {
      expect(await fs.stat('nope/never.txt')).toBeNull();
      await fs.write('s/f.txt', 'abc');
      const f = await fs.stat('s/f.txt');
      expect(f).toMatchObject({ path: 's/f.txt', name: 'f.txt', kind: 'file', size: 3 });
      expect((await fs.stat('s'))?.kind).toBe('directory');
    });

    it('create', async () => {
      await fs.create('docs', 'directory');
      await fs.create('docs/new.txt', 'file');
      await fs.create('deep/er/file.txt', 'file'); // missing parents are created
      expect(await paths('', 3)).toEqual(['deep', 'deep/er', 'deep/er/file.txt', 'docs', 'docs/new.txt']);
      expect(await text('docs/new.txt')).toBe('');
      await expectKind(fs.create('docs/new.txt', 'file'), 'conflict');
      await expectKind(fs.create('docs', 'directory'), 'conflict');
    });

    it('write with expectedMtimeMs', async () => {
      await fs.write('w.txt', 'v1');
      const m0 = (await fs.stat('w.txt'))!.mtimeMs!;
      await sleep(20); // real filesystems have coarse mtime resolution
      const e2 = await fs.write('w.txt', 'v2', { expectedMtimeMs: m0 });
      expect(e2.mtimeMs!).toBeGreaterThan(m0);
      await sleep(20);
      await expectKind(fs.write('w.txt', 'v3', { expectedMtimeMs: m0 }), 'conflict');
      expect(await text('w.txt')).toBe('v2');
      await fs.write('fresh/dir/new.txt', 'x'); // write on a missing file creates it and its parents
      expect(await text('fresh/dir/new.txt')).toBe('x');
    });

    it('writing or uploading a file over a directory is a conflict', async () => {
      await fs.create('folder', 'directory');
      await expectKind(fs.write('folder', 'x'), 'conflict');
      await expectKind(
        fs.upload.direct('folder', new Blob(['x']), { signal: signal(), overwrite: true }),
        'conflict',
      );
      expect((await fs.stat('folder'))?.kind).toBe('directory');
    });

    it('move and copy', async () => {
      await fs.write('x.txt', 'X');
      await fs.write('y.txt', 'Y');
      for (const op of ['move', 'copy'] as const) {
        await expectKind(fs[op]('x.txt', 'y.txt'), 'conflict');
        expect(await text('x.txt')).toBe('X');
        expect(await text('y.txt')).toBe('Y');
      }
      const copied = await fs.copy('x.txt', 'y.txt', { overwrite: true });
      expect(copied.path).toBe('y.txt');
      expect(await text('y.txt')).toBe('X');
      expect(await text('x.txt')).toBe('X');
      await fs.write('z.txt', 'Z');
      await fs.move('z.txt', 'y.txt', { overwrite: true });
      expect(await text('y.txt')).toBe('Z');
      expect(await fs.stat('z.txt')).toBeNull();
      const same1 = await fs.move('x.txt', 'x.txt');
      expect(same1.path).toBe('x.txt');
      expect(await text('x.txt')).toBe('X');
      await expectKind(fs.move('ghost.txt', 'g2.txt'), 'not_found');
      await fs.move('x.txt', 'new/parent/x.txt'); // missing destination parents are created
      expect(await text('new/parent/x.txt')).toBe('X');
    });

    it('move a directory', async () => {
      await fs.write('a/x.txt', 'x');
      await fs.write('a/sub/y.txt', 'y');
      await fs.move('a', 'b');
      expect(await fs.stat('a')).toBeNull();
      expect(await paths('', 5)).toEqual(['b', 'b/sub', 'b/sub/y.txt', 'b/x.txt']);
      expect(await text('b/sub/y.txt')).toBe('y');
      await fs.copy('b', 'c');
      expect(await paths('', 5)).toEqual([
        'b',
        'b/sub',
        'b/sub/y.txt',
        'b/x.txt',
        'c',
        'c/sub',
        'c/sub/y.txt',
        'c/x.txt',
      ]);
      await expectKind(fs.move('b', 'b/inside'), 'invalid');
    });

    it('delete', async () => {
      await expectKind(fs.delete('missing.txt'), 'not_found');
      await fs.write('d/e/f.txt', 'f');
      await fs.write('d/g.txt', 'g');
      await fs.write('keep.txt', 'k');
      await fs.delete('d');
      expect(await paths('', 5)).toEqual(['keep.txt']);
      await expectKind(fs.delete('d'), 'not_found');
    });

    it('upload direct and chunked', async () => {
      const empty = await fs.upload.direct('up/empty.bin', new Blob([]), { signal: signal() });
      expect(empty.path).toBe('up/empty.bin');
      expect((await fs.read('up/empty.bin', 'arrayBuffer')).byteLength).toBe(0);
      await expectKind(fs.upload.direct('up/empty.bin', new Blob(['x']), { signal: signal() }), 'conflict');
      await fs.upload.direct('up/empty.bin', new Blob(['x']), { signal: signal(), overwrite: true });
      expect(await text('up/empty.bin')).toBe('x');

      const { chunked } = fs.upload;
      const probe = await chunked.init('up/probe.bin', 1);
      await chunked.abort(probe.uploadId);
      const { chunkSize } = probe;
      const total = chunkSize * 2 + 7;
      const bytes = new Uint8Array(total).map((_, i) => i % 251);
      const { uploadId } = await chunked.init('up/big.bin', total);
      for (let i = 0, off = 0; off < total; i++, off += chunkSize) {
        await chunked.put(uploadId, i, off, new Blob([bytes.slice(off, off + chunkSize)]), signal());
      }
      const done = await chunked.complete(uploadId);
      expect(done.path).toBe('up/big.bin');
      expect(same(new Uint8Array(await fs.read('up/big.bin', 'arrayBuffer')), bytes)).toBe(true);

      const aborted = await chunked.init('up/aborted.bin', total);
      await chunked.put(aborted.uploadId, 0, 0, new Blob([bytes.slice(0, chunkSize)]), signal());
      await chunked.abort(aborted.uploadId);
      expect(await fs.stat('up/aborted.bin')).toBeNull();
    });

    it('watch', async () => {
      await fs.write('watched.txt', 'one');
      const events: ChangeEvent[] = [];
      const unsubscribe = fs.watch((batch) => events.push(...batch));
      // A remote watcher attaches asynchronously and may report a debounced write as
      // created or updated, so keep rewriting until some event for the path arrives.
      const seen = (): boolean =>
        events.some((e) => (e.type === 'updated' || e.type === 'created') && e.path === 'watched.txt');
      const end = Date.now() + 3000;
      for (let n = 0; !seen(); n++) {
        if (Date.now() > end) throw new Error('no change event for watched.txt within 3s');
        await fs.write('watched.txt', `rewrite ${n}`);
        await sleep(200);
      }
      await sleep(500); // let trailing events from the rewrites drain before unsubscribing
      unsubscribe();
      const mark = events.length;
      await fs.write('watched.txt', 'after unsubscribe');
      await sleep(500);
      expect(events.slice(mark)).toEqual([]);
    });

    it('handles unusual names', async () => {
      const dir = 'dir with space';
      await fs.write(NFC_NAME, 'u1');
      expect(await text(NFC_NAME)).toBe('u1');
      expect(await text(NFD_NAME)).toBe('u1'); // NFC and NFD are the same name
      expect((await fs.stat(NFD_NAME))?.path).toBe(NFC_NAME);
      await fs.write(NFD_NAME, 'u2');
      expect(await paths(dir, 1)).toEqual([NFC_NAME]);
      expect(await text(NFC_NAME)).toBe('u2');
      await expectKind(fs.create(NFD_NAME, 'file'), 'conflict');

      const copy = `${dir}/copy #2 100%.md`;
      await fs.copy(NFD_NAME, copy);
      expect(await text(copy)).toBe('u2');
      await fs.move(copy, `moved dir/${copy.slice(dir.length + 1)}`);
      expect(await text(`moved dir/copy #2 100%.md`)).toBe('u2');
      await fs.upload.direct(`${dir}/upé ?.bin`, new Blob(['b']), { signal: signal() });
      expect(await text(`${dir}/upé ?.bin`)).toBe('b');
      await fs.delete(NFD_NAME);
      expect(await fs.stat(NFC_NAME)).toBeNull();
      await fs.delete(dir);
      expect(await fs.stat(dir)).toBeNull();
    });

    it('search: case-insensitive name match, NFC-insensitive, unusual names, empty query', async () => {
      await fs.write('deep/er/Report.md', '1');
      await fs.write('x/REPORT2.txt', '2');
      await fs.write(NFC_NAME, 'u');
      const found = async (q: string): Promise<string[]> => (await fs.search(q)).map((e) => e.path).sort();
      expect(await found('report')).toEqual(['deep/er/Report.md', 'x/REPORT2.txt']);
      expect(await found('RÉSUMÉ')).toEqual([NFC_NAME]);
      expect(await found(NFD_NAME.slice(NFD_NAME.indexOf('/') + 1))).toEqual([NFC_NAME]); // an NFD query matches
      expect(await found('#1 100%?+')).toEqual([NFC_NAME]);
      expect(await found('with space')).toEqual(['dir with space']);
      expect(await found('')).toEqual([]);
      expect(await found('nothing-like-this')).toEqual([]);
    });
  });
}
