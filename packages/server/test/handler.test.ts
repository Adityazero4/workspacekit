import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, createTreeStore, statusOf } from '@scope/core';
import type { EntriesResponse, Entry, EntryResponse, ErrorBody, UploadInitResponse } from '@scope/core';
import { httpAdapter } from '@scope/core/http';
import { createFileHandler, nodeFsStore, type FileHandlerOptions, type FileStore } from '../src';

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Headers every non-GET request must carry. */
const H = { [CSRF_HEADER]: '1' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let base: string;
let root: string;
let uploadTempDir: string;
let oldTmp: string | undefined;
let store: FileStore;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'handler-')));
  root = path.join(base, 'root');
  uploadTempDir = path.join(base, 'tmp');
  await mkdir(root);
  await mkdir(uploadTempDir);
  oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = uploadTempDir; // os.tmpdir() reads it on every call, so upload temp files land in `uploadTempDir`
  store = nodeFsStore(root, { exclude: ['.git'] });
});
afterEach(async () => {
  if (oldTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = oldTmp;
  await rm(base, { recursive: true, force: true });
});

const make = (o: Partial<FileHandlerOptions> = {}): ((req: Request) => Promise<Response>) =>
  createFileHandler({ store, authorize: () => true, ...o });
const disk = (p: string): Promise<string> => readFile(path.join(root, p), 'utf8');
const put = (p: string, text: string): Promise<Entry> => store.write(p, enc.encode(text));
const url = (route: string, q: Record<string, string | number> = {}, prefix = '/api/files'): string => {
  const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
  return `http://t${prefix}/${route}${qs ? `?${qs}` : ''}`;
};
const post = (route: string, body: unknown, method = 'POST'): Request =>
  new Request(url(route), {
    method,
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const errBody = async (res: Response): Promise<ErrorBody['error']> => ((await res.json()) as ErrorBody).error;
const tempFiles = async (): Promise<string[]> => {
  const out: string[] = [];
  for (const d of await readdir(uploadTempDir)) {
    for (const s of await readdir(path.join(uploadTempDir, d))) out.push(`${d}/${s}`);
  }
  return out;
};
/** Wraps a store and records which methods ran. */
function spy(real: FileStore): { store: FileStore; calls: string[] } {
  const calls: string[] = [];
  const s = new Proxy(real, {
    get(t, k) {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function'
        ? (...a: unknown[]) => (calls.push(String(k)), (v as (...x: unknown[]) => unknown)(...a))
        : v;
    },
  });
  return { store: s, calls };
}

describe('construction, routing and authorization', () => {
  it('throws at construction without authorize', () => {
    expect(() => createFileHandler({ store } as unknown as FileHandlerOptions)).toThrow(/authorize/);
  });

  it('authorize false -> 403 ErrorBody, store not called, with the right op and normalized path', async () => {
    await put('a.txt', 'a');
    const s = spy(store);
    const seen: [string, string][] = [];
    const h = make({ store: s.store, authorize: (_r, op, p) => (seen.push([op, p]), false) });
    const reqs: Request[] = [
      new Request(url('list', { path: '/a//b/' })),
      new Request(url('stat', { path: 'a.txt' })),
      new Request(url('read', { path: 'a.txt' })),
      new Request(url('search', { q: 'a' })),
      post('create', { path: 'n.txt', kind: 'file' }),
      new Request(url('write', { path: 'w.txt' }), { method: 'PUT', headers: H, body: 'x' }),
      post('move', { from: 'a.txt', to: 'b.txt' }),
      post('copy', { from: 'a.txt', to: 'c.txt' }),
      new Request(url('delete', { path: 'a.txt' }), { method: 'DELETE', headers: H }),
      new Request(url('upload', { path: 'u.bin' }), { method: 'POST', headers: H, body: 'x' }),
      post('upload/init', { path: 'u.bin', totalBytes: 1 }),
      post('download', { paths: ['a.txt', 'x/../b.txt'] }),
    ];
    for (const r of reqs) {
      const res = await h(r);
      expect(res.status, `${r.method} ${r.url}`).toBe(403);
      expect((await errBody(res)).kind).toBe('forbidden');
    }
    expect(s.calls).toEqual([]);
    expect(seen).toEqual([
      ['list', 'a/b'],
      ['stat', 'a.txt'],
      ['read', 'a.txt'],
      ['search', ''],
      ['create', 'n.txt'],
      ['write', 'w.txt'],
      ['move', 'a.txt'],
      ['copy', 'a.txt'],
      ['delete', 'a.txt'],
      ['uploadDirect', 'u.bin'],
      ['uploadInit', 'u.bin'],
      ['download', 'a.txt'],
    ]);
  });

  it('authorizes both ends of move/copy and every download path; the second denial also blocks', async () => {
    await put('a.txt', 'a');
    const seen: [string, string][] = [];
    const h = make({ authorize: (_r, op, p) => (seen.push([op, p]), p !== 'locked') });
    expect((await h(post('move', { from: 'a.txt', to: 'locked' }))).status).toBe(403);
    expect((await h(post('copy', { from: 'a.txt', to: 'locked' }))).status).toBe(403);
    expect((await h(post('download', { paths: ['a.txt', 'locked'] }))).status).toBe(403);
    expect(seen).toEqual([
      ['move', 'a.txt'],
      ['move', 'locked'],
      ['copy', 'a.txt'],
      ['copy', 'locked'],
      ['download', 'a.txt'],
      ['download', 'locked'],
    ]);
    expect(await disk('a.txt')).toBe('a');
  });

  it('authorizes chunk, complete and abort against the session target path', async () => {
    const seen: [string, string][] = [];
    let deny = false;
    const h = make({ authorize: (_r, op, p) => (seen.push([op, p]), !deny) });
    const { uploadId } = (await (
      await h(post('upload/init', { path: 'dir/u.bin', totalBytes: 3 }))
    ).json()) as UploadInitResponse;
    deny = true;
    const chunk = new Request(url('upload/chunk', { id: uploadId, index: 0, offset: 0 }), {
      method: 'PUT',
      headers: H,
      body: 'abc',
    });
    expect((await h(chunk)).status).toBe(403);
    expect((await h(post('upload/complete', { uploadId }))).status).toBe(403);
    expect(
      (await h(new Request(url('upload', { id: uploadId }), { method: 'DELETE', headers: H }))).status,
    ).toBe(403);
    expect(seen.slice(1)).toEqual([
      ['uploadChunk', 'dir/u.bin'],
      ['uploadComplete', 'dir/u.bin'],
      ['uploadAbort', 'dir/u.bin'],
    ]);
    deny = false;
    expect(
      (await h(new Request(url('upload', { id: uploadId }), { method: 'DELETE', headers: H }))).status,
    ).toBe(204);
  });

  it('routes by pathname suffix regardless of base path; unknown route 404; wrong method 405', async () => {
    await put('a.txt', 'a');
    const h = make();
    for (const prefix of ['/api/files', '/fs', '', '/a/b/c']) {
      const res = await h(new Request(url('list', { path: '' }, prefix)));
      expect(res.status, prefix).toBe(200);
      expect(((await res.json()) as EntriesResponse).entries.map((e) => e.path)).toEqual(['a.txt']);
    }
    const nope = await h(new Request('http://t/api/files/nope'));
    expect(nope.status).toBe(404);
    expect((await errBody(nope)).kind).toBe('not_found');
    const wrong = await h(new Request(url('list'), { method: 'POST', headers: H }));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('GET');
  });

  it('readOnly rejects every write op with 403 and still serves reads', async () => {
    await put('a.txt', 'a');
    const h = make({ readOnly: true });
    const writes: Request[] = [
      post('create', { path: 'n', kind: 'file' }),
      new Request(url('write', { path: 'a.txt' }), { method: 'PUT', headers: H, body: 'x' }),
      post('move', { from: 'a.txt', to: 'b' }),
      post('copy', { from: 'a.txt', to: 'b' }),
      new Request(url('delete', { path: 'a.txt' }), { method: 'DELETE', headers: H }),
      new Request(url('upload', { path: 'u' }), { method: 'POST', headers: H, body: 'x' }),
      post('upload/init', { path: 'u', totalBytes: 1 }),
      new Request(url('upload/chunk', { id: 'x', index: 0, offset: 0 }), {
        method: 'PUT',
        headers: H,
        body: 'x',
      }),
      post('upload/complete', { uploadId: 'x' }),
      new Request(url('upload', { id: 'x' }), { method: 'DELETE', headers: H }),
    ];
    for (const r of writes) expect((await h(r)).status, `${r.method} ${r.url}`).toBe(403);
    expect(await disk('a.txt')).toBe('a');
    expect((await h(new Request(url('read', { path: 'a.txt' })))).status).toBe(200);
    expect((await h(new Request(url('list')))).status).toBe(200);
    expect((await h(post('download', { paths: ['a.txt'] }))).status).toBe(200);
  });
});

describe('metadata and mutation routes', () => {
  it('list, stat, search, create, write, move, copy, delete', async () => {
    const h = make();
    const json = async <T>(r: Request): Promise<T> => (await h(r)).json() as Promise<T>;
    const created = await json<EntryResponse>(post('create', { path: 'd/e', kind: 'directory' }));
    expect(created.entry).toMatchObject({ path: 'd/e', kind: 'directory' });
    expect((await h(post('create', { path: 'd/e', kind: 'directory' }))).status).toBe(409);
    const w = await h(
      new Request(url('write', { path: 'd/e/f.txt' }), { method: 'PUT', headers: H, body: 'héllo' }),
    );
    expect(w.status).toBe(200);
    expect(await disk('d/e/f.txt')).toBe('héllo');
    const st = await json<{ entry: Entry | null }>(new Request(url('stat', { path: 'd/e/f.txt' })));
    expect(st.entry).toMatchObject({ path: 'd/e/f.txt', size: 6 });
    expect(
      (await json<{ entry: Entry | null }>(new Request(url('stat', { path: 'nope' })))).entry,
    ).toBeNull();
    expect(
      (await json<EntriesResponse>(new Request(url('list', { path: 'd', depth: 2 })))).entries
        .map((e) => e.path)
        .sort(),
    ).toEqual(['d/e', 'd/e/f.txt']);
    expect(
      (await json<EntriesResponse>(new Request(url('search', { q: 'F.TX' })))).entries.map((e) => e.path),
    ).toEqual(['d/e/f.txt']);
    expect((await h(new Request(url('list', { path: 'missing' })))).status).toBe(404);
    expect((await h(new Request(url('list', { depth: 'x' })))).status).toBe(400);
    expect((await h(post('copy', { from: 'd/e/f.txt', to: 'g.txt' }))).status).toBe(200);
    expect((await h(post('copy', { from: 'd/e/f.txt', to: 'g.txt' }))).status).toBe(409);
    expect((await h(post('copy', { from: 'd/e/f.txt', to: 'g.txt', overwrite: true }))).status).toBe(200);
    expect((await h(post('move', { from: 'g.txt', to: 'h.txt' }))).status).toBe(200);
    expect(await disk('h.txt')).toBe('héllo');
    expect(
      (await h(new Request(url('delete', { path: 'h.txt' }), { method: 'DELETE', headers: H }))).status,
    ).toBe(204);
    expect(await stat(path.join(root, 'h.txt')).catch(() => null)).toBeNull();
    expect((await h(post('create', { path: 'x', kind: 'bogus' }))).status).toBe(400);
    expect((await h(new Request(url('create'), { method: 'POST', headers: H, body: '{nope' }))).status).toBe(
      400,
    );
    expect((await h(post('move', { from: 'a' }))).status).toBe(400);
  });

  it('write overwrites an existing file, honours If-Mtime-Ms (409) and creates parents', async () => {
    const e = await put('a.txt', 'one');
    const h = make();
    const mk = (hdr?: string): Request =>
      new Request(url('write', { path: 'a.txt' }), {
        method: 'PUT',
        body: 'two',
        headers: { ...H, ...(hdr ? { 'If-Mtime-Ms': hdr } : {}) },
      });
    expect((await h(mk())).status).toBe(200);
    expect(await disk('a.txt')).toBe('two');
    expect((await h(mk(String(e.mtimeMs! + 12345)))).status).toBe(409);
    expect((await h(mk('abc'))).status).toBe(400);
    expect(
      (await h(new Request(url('write', { path: 'p/q/r.txt' }), { method: 'PUT', headers: H, body: 'x' })))
        .status,
    ).toBe(200);
    expect(await disk('p/q/r.txt')).toBe('x');
  });
});

describe('read', () => {
  it('supports Range (206, Content-Range) and sets attachment, nosniff, CSP and mtime headers', async () => {
    const e = await put('dir/Réport.txt', '0123456789');
    const h = make();
    const full = await h(new Request(url('read', { path: 'dir/Réport.txt', v: 5 })));
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('0123456789');
    expect(full.headers.get('Content-Length')).toBe('10');
    expect(full.headers.get('X-Mtime-Ms')).toBe(String(e.mtimeMs));
    expect(full.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(full.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(full.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(full.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''R%C3%A9port.txt");
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');

    const get = (range: string): Promise<Response> =>
      h(new Request(url('read', { path: 'dir/Réport.txt' }), { headers: { Range: range } }));
    const a = await get('bytes=2-4');
    expect(a.status).toBe(206);
    expect(a.headers.get('Content-Range')).toBe('bytes 2-4/10');
    expect(a.headers.get('Content-Length')).toBe('3');
    expect(await a.text()).toBe('234');
    const b = await get('bytes=7-');
    expect([b.status, b.headers.get('Content-Range'), await b.text()]).toEqual([206, 'bytes 7-9/10', '789']);
    const c = await get('bytes=-3');
    expect([c.status, c.headers.get('Content-Range'), await c.text()]).toEqual([206, 'bytes 7-9/10', '789']);
    const d = await get('bytes=5-999');
    expect([d.status, d.headers.get('Content-Range'), await d.text()]).toEqual([
      206,
      'bytes 5-9/10',
      '56789',
    ]);
    const big = await get('bytes=-99');
    expect([big.status, big.headers.get('Content-Range')]).toEqual([206, 'bytes 0-9/10']);
    const bad = await get('bytes=10-12');
    expect(bad.status).toBe(416);
    expect(bad.headers.get('Content-Range')).toBe('bytes */10');
    expect((await get('bytes=-0')).status).toBe(416);
    const multi = await get('bytes=0-1,4-5');
    expect([multi.status, await multi.text()]).toEqual([200, '0123456789']);
    const junk = await get('lines=1-2');
    expect([junk.status, await junk.text()]).toEqual([200, '0123456789']);
  });

  it('serves Content-Type from the extension allowlist; html and unknown are octet-stream', async () => {
    const h = make();
    const types: Record<string, string> = {
      'a.png': 'image/png',
      'a.JPG': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.gif': 'image/gif',
      'a.webp': 'image/webp',
      'a.avif': 'image/avif',
      'a.bmp': 'image/bmp',
      'a.ico': 'image/x-icon',
      'a.svg': 'image/svg+xml',
      'a.tif': 'image/tiff',
      'a.tiff': 'image/tiff',
      'a.mp4': 'video/mp4',
      'a.m4v': 'video/mp4',
      'a.webm': 'video/webm',
      'a.mov': 'video/quicktime',
      'a.mp3': 'audio/mpeg',
      'a.wav': 'audio/wav',
      'a.ogg': 'audio/ogg',
      'a.oga': 'audio/ogg',
      'a.flac': 'audio/flac',
      'a.aac': 'audio/aac',
      'a.m4a': 'audio/mp4',
      'a.pdf': 'application/pdf',
      'a.txt': 'text/plain; charset=utf-8',
      'a.md': 'text/plain; charset=utf-8',
      'a.json': 'text/plain; charset=utf-8',
      'a.ts': 'text/plain; charset=utf-8',
      'a.css': 'text/plain; charset=utf-8',
      'a.sh': 'text/plain; charset=utf-8',
      'a.html': 'application/octet-stream',
      'a.htm': 'application/octet-stream',
      'a.xhtml': 'application/octet-stream',
      'a.js.map': 'application/octet-stream',
      'a.exe': 'application/octet-stream',
      Makefile: 'application/octet-stream',
    };
    for (const name of Object.keys(types)) await put(name, 'x');
    for (const [name, type] of Object.entries(types)) {
      const res = await h(new Request(url('read', { path: name })));
      expect(res.headers.get('Content-Type'), name).toBe(type);
      expect(res.headers.get('X-Content-Type-Options'), name).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy'), name).toBe("default-src 'none'; sandbox");
      await res.body?.cancel();
    }
  });

  it('read of a missing file is 404 and of a directory is 400', async () => {
    await store.create('d', 'directory');
    const h = make();
    expect((await h(new Request(url('read', { path: 'nope.txt' })))).status).toBe(404);
    expect((await h(new Request(url('read', { path: 'd' })))).status).toBe(400);
    expect(
      (await h(new Request(url('read', { path: 'd' }), { headers: { Range: 'bytes=0-1' } }))).status,
    ).toBe(400);
  });

  it('cancels the store body when the request aborts or the response body is cancelled', async () => {
    const entry: Entry = { path: 'x.txt', name: 'x.txt', kind: 'file', size: 100, mtimeMs: 1 };
    const cancelled = vi.fn();
    const slow: FileStore = {
      ...store,
      read: async () => ({
        body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: cancelled }),
        size: 100,
        entry,
      }),
    };
    const h = make({ store: slow });
    const ac = new AbortController();
    const res = await h(new Request(url('read', { path: 'x.txt' }), { signal: ac.signal }));
    ac.abort();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    await res.body?.cancel().catch(() => {});

    const secondResponse = await h(new Request(url('read', { path: 'x.txt' })));
    await secondResponse.body?.cancel();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2));
  });
});

describe('limits', () => {
  it('write over maxWriteBytes -> 413 and file unchanged (declared and streamed)', async () => {
    await put('a.txt', 'keep');
    const h = make({ maxWriteBytes: 8 });
    const declared = await h(
      new Request(url('write', { path: 'a.txt' }), { method: 'PUT', headers: H, body: '123456789' }),
    );
    expect(declared.status).toBe(413);
    expect((await errBody(declared)).kind).toBe('too_large');
    const streamed = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc.encode('12345'));
      },
    });
    const res = await h(
      new Request(url('write', { path: 'a.txt' }), {
        method: 'PUT',
        headers: H,
        body: streamed,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await disk('a.txt')).toBe('keep');
    expect((await readdir(root)).sort()).toEqual(['a.txt']);
    expect(
      (await h(new Request(url('write', { path: 'a.txt' }), { method: 'PUT', headers: H, body: '12345678' })))
        .status,
    ).toBe(200);
  });

  it('JSON request bodies over 1 MiB -> 413', async () => {
    const h = make();
    const big = JSON.stringify({ path: 'a', kind: 'file', pad: 'x'.repeat(1024 * 1024) });
    const res = await h(new Request(url('create'), { method: 'POST', headers: H, body: big }));
    expect(res.status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(100_000));
      },
    });
    const secondResponse = await h(
      new Request(url('create'), {
        method: 'POST',
        headers: H,
        body: streamed,
        duplex: 'half',
      } as RequestInit),
    );
    expect(secondResponse.status).toBe(413);
  });
});

describe('uploads', () => {
  const init = async (
    h: (r: Request) => Promise<Response>,
    p: string,
    total: number,
    extra = {},
  ): Promise<UploadInitResponse> => {
    const res = await h(post('upload/init', { path: p, totalBytes: total, ...extra }));
    expect(res.status).toBe(200);
    return (await res.json()) as UploadInitResponse;
  };
  const chunk = (id: string, index: number, offset: number, data: string | Uint8Array): Request =>
    new Request(url('upload/chunk', { id, index, offset }), {
      method: 'PUT',
      headers: H,
      body: data as BodyInit,
    });

  it('chunked upload: init, out-of-order chunks, idempotent re-put, complete assembles exact bytes; temp is outside the root', async () => {
    const h = make({ chunkSize: 4 });
    const { uploadId, chunkSize } = await init(h, 'up/f.bin', 10);
    expect(chunkSize).toBe(4);
    expect((await h(chunk(uploadId, 2, 8, 'ij'))).status).toBe(204);
    expect((await h(chunk(uploadId, 0, 0, 'abcd'))).status).toBe(204);
    expect((await h(chunk(uploadId, 0, 0, 'abcd'))).status).toBe(204); // idempotent
    expect((await h(post('upload/complete', { uploadId }))).status).toBe(400); // chunk 1 missing
    expect((await h(chunk(uploadId, 1, 4, 'efgh'))).status).toBe(204);
    expect((await tempFiles()).length).toBeGreaterThan(0);
    const done = await h(post('upload/complete', { uploadId }));
    expect(done.status).toBe(200);
    expect(((await done.json()) as EntryResponse).entry).toMatchObject({ path: 'up/f.bin', size: 10 });
    expect(await disk('up/f.bin')).toBe('abcdefghij');
    expect(await tempFiles()).toEqual([]);
    expect((await readdir(path.join(root, 'up'))).sort()).toEqual(['f.bin']);
    expect((await h(post('upload/complete', { uploadId }))).status).toBe(404);
  });

  it('validates chunks: index, offset, size, and a body larger than chunkSize -> 413', async () => {
    const h = make({ chunkSize: 4 });
    const { uploadId } = await init(h, 'f.bin', 6);
    expect((await h(chunk(uploadId, 0, 0, 'abcde'))).status).toBe(413);
    expect((await h(chunk(uploadId, 2, 8, 'x'))).status).toBe(400); // beyond the file
    expect((await h(chunk(uploadId, 1, 3, 'ef'))).status).toBe(400); // wrong offset
    expect((await h(chunk(uploadId, 0, 0, 'abc'))).status).toBe(400); // short non-final chunk
    expect((await h(chunk(uploadId, 1, 4, 'efg'))).status).toBe(400); // final chunk too long
    expect(
      (
        await h(
          new Request(url('upload/chunk', { id: uploadId, index: 'x', offset: 0 }), {
            method: 'PUT',
            headers: H,
            body: 'a',
          }),
        )
      ).status,
    ).toBe(400);
    expect((await h(chunk(uploadId, 0, 0, 'abcd'))).status).toBe(204);
    expect((await h(chunk(uploadId, 1, 4, 'ef'))).status).toBe(204);
    expect((await h(post('upload/complete', { uploadId }))).status).toBe(200);
    expect(await disk('f.bin')).toBe('abcdef');
  });

  it('abort deletes temp data; unknown id -> 404; expired sessions are swept', async () => {
    const h = make({ chunkSize: 4, uploadTtlMs: 40 });
    const a = await init(h, 'a.bin', 8);
    await h(chunk(a.uploadId, 0, 0, 'abcd'));
    expect(await tempFiles()).toHaveLength(1); // one session dir
    expect(
      (await h(new Request(url('upload', { id: a.uploadId }), { method: 'DELETE', headers: H }))).status,
    ).toBe(204);
    expect(await tempFiles()).toEqual([]);
    expect(
      (await h(new Request(url('upload', { id: a.uploadId }), { method: 'DELETE', headers: H }))).status,
    ).toBe(404);
    expect((await h(chunk('nope', 0, 0, 'abcd'))).status).toBe(404);
    expect((await h(post('upload/complete', { uploadId: 'nope' }))).status).toBe(404);

    const old = await init(h, 'old.bin', 8);
    await h(chunk(old.uploadId, 0, 0, 'abcd'));
    await sleep(120);
    const fresh = await init(h, 'fresh.bin', 8); // any upload request sweeps
    expect((await h(chunk(old.uploadId, 1, 4, 'efgh'))).status).toBe(404);
    expect(await tempFiles()).toHaveLength(1); // only fresh's session dir is left
    expect((await h(chunk(fresh.uploadId, 0, 0, 'abcd'))).status).toBe(204);
    expect(await stat(path.join(root, 'old.bin')).catch(() => null)).toBeNull();
  });

  it('upload over maxUploadBytes is rejected at init (413); bad totalBytes -> 400', async () => {
    const h = make({ maxUploadBytes: 10 });
    const res = await h(post('upload/init', { path: 'a.bin', totalBytes: 11 }));
    expect(res.status).toBe(413);
    expect((await errBody(res)).kind).toBe('too_large');
    expect((await h(post('upload/init', { path: 'a.bin', totalBytes: -1 }))).status).toBe(400);
    expect((await h(post('upload/init', { path: 'a.bin', totalBytes: 1.5 }))).status).toBe(400);
    expect((await h(post('upload/init', { path: 'a.bin', totalBytes: '5' }))).status).toBe(400);
    expect((await h(post('upload/init', { path: 'a.bin', totalBytes: 10 }))).status).toBe(200);
  });

  it('init on an existing path is 409 unless overwrite; complete replaces only then; complete passes overwrite:false explicitly', async () => {
    await put('x.bin', 'old');
    const h = make();
    const conflict = await h(post('upload/init', { path: 'x.bin', totalBytes: 3 }));
    expect(conflict.status).toBe(409);
    expect((await errBody(conflict)).path).toBe('x.bin');
    await store.create('dir', 'directory');
    expect((await h(post('upload/init', { path: 'dir', totalBytes: 3, overwrite: true }))).status).toBe(409);
    const { uploadId } = await init(h, 'x.bin', 3, { overwrite: true });
    await h(chunk(uploadId, 0, 0, 'new'));
    expect((await h(post('upload/complete', { uploadId }))).status).toBe(200);
    expect(await disk('x.bin')).toBe('new');

    // a file that appears after init must not be clobbered when overwrite was not requested
    const late = await init(h, 'late.bin', 3);
    await h(chunk(late.uploadId, 0, 0, 'abc'));
    await put('late.bin', 'sneaky');
    expect((await h(post('upload/complete', { uploadId: late.uploadId }))).status).toBe(409);
    expect(await disk('late.bin')).toBe('sneaky');
  });

  it('empty file: init with 0 bytes and complete without chunks', async () => {
    const h = make();
    const { uploadId } = await init(h, 'e/empty.bin', 0);
    expect((await h(post('upload/complete', { uploadId }))).status).toBe(200);
    expect(await disk('e/empty.bin')).toBe('');
  });

  it('direct upload: 409 without overwrite, 200 with overwrite=1, 413 over maxUploadBytes, creates parents', async () => {
    const h = make({ maxUploadBytes: 5 });
    const up = (q: Record<string, string>, body: string): Promise<Response> =>
      h(
        new Request(url('upload', q), {
          method: 'POST',
          body,
          headers: { ...H, 'Content-Type': 'application/octet-stream' },
        }),
      );
    expect((await up({ path: 'a/b/c.bin' }, 'one')).status).toBe(200);
    expect(await disk('a/b/c.bin')).toBe('one');
    expect((await up({ path: 'a/b/c.bin' }, 'two')).status).toBe(409);
    expect(await disk('a/b/c.bin')).toBe('one');
    expect((await up({ path: 'a/b/c.bin', overwrite: '1' }, 'two')).status).toBe(200);
    expect(await disk('a/b/c.bin')).toBe('two');
    expect((await up({ path: 'a/b/c.bin', overwrite: '1' }, '123456')).status).toBe(413);
    expect(await disk('a/b/c.bin')).toBe('two');
    expect((await up({ path: 'z.bin' }, '')).status).toBe(200);
    expect(await disk('z.bin')).toBe('');
  });
});

describe('download', () => {
  it('one file streams it with attachment headers; several paths stream a zip whose entries match', async () => {
    await put('a.txt', 'AAA');
    await put('dir/b.txt', 'BBB');
    await put('dir/sub/c.txt', 'CCC');
    await store.create('dir/empty', 'directory');
    await put('other/d.txt', 'DDD');
    const h = make();
    const one = await h(post('download', { paths: ['dir/b.txt'] }));
    expect(one.status).toBe(200);
    expect(one.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''b.txt");
    expect(one.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(one.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(one.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(await one.text()).toBe('BBB');

    const zip = await h(post('download', { paths: ['a.txt', 'dir', 'other/d.txt', 'a.txt', 'dir/b.txt'] }));
    expect(zip.status).toBe(200);
    expect(zip.headers.get('Content-Type')).toBe('application/zip');
    expect(zip.headers.get('Content-Disposition')).toMatch(/^attachment; filename\*=UTF-8''/);
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const text = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, dec.decode(v)]));
    expect(text).toEqual({
      'a.txt': 'AAA',
      'dir/': '',
      'dir/b.txt': 'BBB',
      'dir/sub/': '',
      'dir/sub/c.txt': 'CCC',
      'dir/empty/': '',
      'd.txt': 'DDD',
      'b.txt': 'BBB', // dir/b.txt asked for on its own: named relative to its parent
    });

    const dirOnly = await h(post('download', { paths: ['dir/sub'] }));
    expect(dirOnly.headers.get('Content-Type')).toBe('application/zip');
    expect(dirOnly.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''sub.zip");
    expect(Object.keys(unzipSync(new Uint8Array(await dirOnly.arrayBuffer()))).sort()).toEqual([
      'sub/',
      'sub/c.txt',
    ]);
  });

  it('excluded names stay hidden, missing paths 404, empty or invalid body 400', async () => {
    await put('d/ok.txt', 'ok');
    await mkdir(path.join(root, 'd/.git'));
    await writeFile(path.join(root, 'd/.git/config'), 'secret');
    const h = make();
    const files = unzipSync(
      new Uint8Array(await (await h(post('download', { paths: ['d'] }))).arrayBuffer()),
    );
    expect(Object.keys(files).sort()).toEqual(['d/', 'd/ok.txt']);
    expect((await h(post('download', { paths: ['d/.git/config'] }))).status).toBe(404);
    expect((await h(post('download', { paths: ['d/ok.txt', 'nope'] }))).status).toBe(404);
    expect((await h(post('download', { paths: [] }))).status).toBe(400);
    expect((await h(post('download', { paths: [1] }))).status).toBe(400);
    expect((await h(post('download', {}))).status).toBe(400);
  });
});

describe('CSRF header', () => {
  it('every non-GET route needs X-FS-Request: 1 (403 before authorize and readOnly); GET does not', async () => {
    await put('a.txt', 'a');
    const authorize = vi.fn(() => true);
    const h = make({ authorize, readOnly: true });
    const bare = (route: string, method: string, q: Record<string, string> = {}): Request =>
      new Request(url(route, q), { method, body: method === 'DELETE' ? null : '{}' });
    const cases: [string, string, Record<string, string>?][] = [
      ['create', 'POST'],
      ['write', 'PUT', { path: 'a.txt' }],
      ['move', 'POST'],
      ['copy', 'POST'],
      ['delete', 'DELETE', { path: 'a.txt' }],
      ['upload', 'POST', { path: 'u' }],
      ['upload/init', 'POST'],
      ['upload/chunk', 'PUT', { id: 'x', index: '0', offset: '0' }],
      ['upload/complete', 'POST'],
      ['upload', 'DELETE', { id: 'x' }],
      ['download', 'POST'],
    ];
    for (const [route, method, q] of cases) {
      const res = await h(bare(route, method, q));
      expect(res.status, `${method} ${route}`).toBe(403);
      const e = await errBody(res);
      expect(e.kind).toBe('forbidden');
      expect(e.message).toContain(CSRF_HEADER);
    }
    const wrong = new Request(url('delete', { path: 'a.txt' }), {
      method: 'DELETE',
      headers: { [CSRF_HEADER]: '0' },
    });
    expect((await h(wrong)).status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
    expect(await disk('a.txt')).toBe('a');
    expect((await h(new Request(url('list')))).status).toBe(200); // GET: no header needed
    const rw = make();
    const ok = await rw(new Request(url('delete', { path: 'a.txt' }), { method: 'DELETE', headers: H }));
    expect(ok.status).toBe(204);
  });
});

describe('zip limits', () => {
  const dirEntry: Entry = { path: 'big', name: 'big', kind: 'directory', size: null, mtimeMs: 1 };
  const file = (i: number, size: number): Entry => ({
    path: `big/f${i}`,
    name: `f${i}`,
    kind: 'file',
    size,
    mtimeMs: 1,
  });
  const fake = (children: Entry[]): FileStore => ({
    ...store,
    stat: async (p) => (p === 'big' ? dirEntry : null),
    list: async () => children,
    read: async (p) => ({
      body: new Blob([]).stream() as ReadableStream<Uint8Array>,
      size: 0,
      entry: file(0, 0),
      ...{ p },
    }),
  });

  it('413 before streaming when the archive would need zip64 (>= 4 GiB or more than 65535 entries)', async () => {
    const big = async (children: Entry[]): Promise<Response> =>
      make({ store: fake(children) })(post('download', { paths: ['big'] }));
    for (const children of [
      [file(0, 0xffffffff)],
      [file(0, 0x80000000), file(1, 0x80000000)],
      Array.from({ length: 65_536 }, (_, i) => file(i, 0)),
    ]) {
      const res = await big(children);
      expect(res.status).toBe(413);
      expect((await errBody(res)).kind).toBe('too_large');
    }
    // exact boundary: sizes + per-entry overhead (30 + 16 + 46 + 2 * name bytes: 'big/' = 100, 'big/f0' = 104)
    const room = 0xffffffff - 204;
    expect((await big([file(0, room)])).status).toBe(413);
    expect((await big([file(0, room - 1)])).status).toBe(200);
    const ok = await big([file(0, 0), file(1, 0)]);
    expect(ok.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await ok.arrayBuffer()))).sort()).toEqual([
      'big/',
      'big/f0',
      'big/f1',
    ]);
  });
});

describe('per-entry authorization of directory operations', () => {
  it('directory download skips files authorize denies (requested path itself stays allowed)', async () => {
    await put('d/ok.txt', 'ok');
    await put('d/secret.txt', 'no');
    await put('d/sub/in.txt', 'in');
    const seen: string[] = [];
    const h = make({ authorize: (_r, op, p) => (seen.push(`${op}:${p}`), p !== 'd/secret.txt') });
    const res = await h(post('download', { paths: ['d'] }));
    expect(res.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer()))).sort()).toEqual([
      'd/',
      'd/ok.txt',
      'd/sub/',
      'd/sub/in.txt',
    ]);
    expect(seen).toContain('download:d/secret.txt');
    expect(seen).toContain('download:d/ok.txt');
    expect(seen).toContain('download:d/sub/in.txt');
    // a denied requested path is still a hard 403
    const denied = make({ authorize: (_r, _o, p) => p !== 'd' });
    expect((await denied(post('download', { paths: ['d'] }))).status).toBe(403);
  });

  it('directory download leaves out a denied subfolder and everything under it', async () => {
    await put('d/ok.txt', 'ok');
    await put('d/private/a.txt', 'a');
    await put('d/private/deeper/b.txt', 'b');
    await put('d/privately.txt', 'sibling with a shared name prefix');
    const seen: string[] = [];
    const h = make({ authorize: (_r, op, p) => (seen.push(`${op}:${p}`), p !== 'd/private') });
    const res = await h(post('download', { paths: ['d'] }));
    expect(res.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer()))).sort()).toEqual([
      'd/',
      'd/ok.txt',
      'd/privately.txt',
    ]);
    expect(seen).toContain('download:d/private');
    expect(seen).not.toContain('download:d/private/a.txt'); // the subtree is never even asked about
  });

  it('copy/move of a folder with a denied descendant -> 403 and nothing changed', async () => {
    await put('src/ok.txt', 'ok');
    await put('src/deep/secret.txt', 'no');
    const seen: string[] = [];
    const h = make({ authorize: (_r, op, p) => (seen.push(`${op}:${p}`), p !== 'src/deep/secret.txt') });
    for (const op of ['copy', 'move'] as const) {
      const res = await h(post(op, { from: 'src', to: 'dst' }));
      expect(res.status, op).toBe(403);
      expect((await errBody(res)).kind).toBe('forbidden');
      expect(seen).toContain(`${op}:src/deep/secret.txt`);
      expect(await stat(path.join(root, 'dst')).catch(() => null)).toBeNull();
      expect(await disk('src/ok.txt')).toBe('ok');
      expect(await disk('src/deep/secret.txt')).toBe('no');
    }
    const allowed = make();
    expect((await allowed(post('copy', { from: 'src', to: 'dst' }))).status).toBe(200);
    expect(await disk('dst/deep/secret.txt')).toBe('no');
  });

  it('overwriting a destination needs delete rights on it and on everything inside it', async () => {
    await put('a.txt', 'A');
    await put('dir/ok.txt', 'ok');
    await put('dir/deep/secret.txt', 'no');
    await put('file.txt', 'old');
    const denyDelete = (denied: string): ReturnType<typeof make> =>
      make({ authorize: (_r, op, p) => !(op === 'delete' && p === denied) });
    const intact = async (): Promise<void> => {
      expect(await disk('dir/ok.txt')).toBe('ok');
      expect(await disk('dir/deep/secret.txt')).toBe('no');
      expect(await disk('a.txt')).toBe('A');
      expect(await disk('file.txt')).toBe('old');
    };
    for (const op of ['copy', 'move'] as const) {
      for (const denied of ['dir/deep/secret.txt', 'dir']) {
        const res = await denyDelete(denied)(post(op, { from: 'a.txt', to: 'dir', overwrite: true }));
        expect(res.status, `${op} over dir, delete denied on ${denied}`).toBe(403);
        await intact();
      }
      const onFile = await denyDelete('file.txt')(
        post(op, { from: 'a.txt', to: 'file.txt', overwrite: true }),
      );
      expect(onFile.status, `${op} over file`).toBe(403);
      await intact();
    }
    // without overwrite nothing is deleted, so delete rights are not asked for
    const seen: string[] = [];
    const h = make({ authorize: (_r, op, p) => (seen.push(`${op}:${p}`), op !== 'delete') });
    expect((await h(post('copy', { from: 'a.txt', to: 'dir' }))).status).toBe(409);
    expect(seen.filter((x) => x.startsWith('delete:'))).toEqual([]);
    // allowed: replaces the folder, after asking about it and its contents
    const asked: string[] = [];
    const ok = make({ authorize: (_r, op, p) => (asked.push(`${op}:${p}`), true) });
    expect((await ok(post('copy', { from: 'a.txt', to: 'dir', overwrite: true }))).status).toBe(200);
    expect(asked).toEqual(
      expect.arrayContaining([
        'delete:dir',
        'delete:dir/ok.txt',
        'delete:dir/deep',
        'delete:dir/deep/secret.txt',
      ]),
    );
    expect(await disk('dir')).toBe('A');
  });

  it('deleting a folder needs delete rights on every descendant; nothing changes on a denial', async () => {
    await put('d/ok.txt', 'ok');
    await put('d/sub/secret.txt', 'no');
    const seen: string[] = [];
    const h = make({
      authorize: (_r, op, p) => (seen.push(`${op}:${p}`), !(op === 'delete' && p === 'd/sub/secret.txt')),
    });
    const res = await h(new Request(url('delete', { path: 'd' }), { method: 'DELETE', headers: H }));
    expect(res.status).toBe(403);
    expect(seen).toEqual(expect.arrayContaining(['delete:d', 'delete:d/sub/secret.txt']));
    expect(await disk('d/ok.txt')).toBe('ok');
    expect(await disk('d/sub/secret.txt')).toBe('no');
    const all = make();
    expect(
      (await all(new Request(url('delete', { path: 'd' }), { method: 'DELETE', headers: H }))).status,
    ).toBe(204);
    expect(await stat(path.join(root, 'd')).catch(() => null)).toBeNull();
  });

  it('a download body with a lone surrogate is 400', async () => {
    const h = make();
    const res = await h(
      new Request(url('download'), { method: 'POST', headers: H, body: '{"paths":["a\\ud800b"]}' }),
    );
    expect(res.status).toBe(400);
    expect((await errBody(res)).kind).toBe('invalid');
  });
});

describe('errors', () => {
  it('never leaks absolute server paths or stack traces; unknown errors are generic 500 and reach onError', async () => {
    const onError = vi.fn();
    const boom: FileStore = {
      ...store,
      read: async () => {
        throw new Error(`EMFILE: too many open files, open '${root}/secret/a.txt'`);
      },
      stat: async () => {
        throw Object.assign(new Error(`EIO ${root}`), { code: 'EIO' });
      },
    };
    const h = make({ store: boom, onError });
    const res = await h(new Request(url('read', { path: 'a.txt' })));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(base);
    expect(text).not.toContain(' at ');
    expect(JSON.parse(text)).toEqual({ error: { kind: 'unknown', message: 'internal error' } });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toContain(root);
    expect(onError.mock.calls[0]![1]).toBeInstanceOf(Request);

    // thrown by authorize
    const h2 = make({
      authorize: () => {
        throw new Error(root);
      },
      onError,
    });
    const r2 = await h2(new Request(url('list')));
    expect([r2.status, (await r2.text()).includes(base)]).toEqual([500, false]);
    expect(onError).toHaveBeenCalledTimes(2);

    // real store errors carry only the relative path
    const real = make({ onError });
    const missing = await real(new Request(url('read', { path: 'deep/nope.txt' })));
    expect(missing.status).toBe(404);
    const body = await errBody(missing);
    expect(body.path).toBe('deep/nope.txt');
    expect(JSON.stringify(body)).not.toContain(base);
    const esc = await real(new Request(url('read', { path: '../../etc/passwd' })));
    expect(esc.status).toBe(403);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a throwing onError does not break the response', async () => {
    const h = make({
      store: {
        ...store,
        stat: async () => {
          throw new Error('x');
        },
      },
      onError: () => {
        throw new Error('logger down');
      },
    });
    expect((await h(new Request(url('stat', { path: 'a' })))).status).toBe(500);
  });
});

describe('httpAdapter against the handler', () => {
  it('round-trips write, read, upload and download through the real client', async () => {
    const h = make({ chunkSize: 4 });
    const fs = httpAdapter('http://t/api/files', {
      fetch: ((u: string, i?: RequestInit) => h(new Request(u, i))) as typeof fetch,
    });
    await fs.write!('n/a.txt', 'héllo');
    expect(await fs.read('n/a.txt', 'text')).toBe('héllo');
    const t = fs.upload!.chunked!;
    const { uploadId } = await t.init('n/big.bin', 6);
    await t.put(uploadId, 1, 4, new Blob(['ef']), new AbortController().signal);
    await t.put(uploadId, 0, 0, new Blob(['abcd']), new AbortController().signal);
    expect((await t.complete(uploadId)).size).toBe(6);
    expect(await disk('n/big.bin')).toBe('abcdef');
    await expect(
      fs.upload!.direct('n/big.bin', new Blob(['x']), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    const zip = await fs.download!(['n/a.txt', 'n/big.bin']);
    expect(Object.keys(unzipSync(new Uint8Array(await (zip as Blob).arrayBuffer()))).sort()).toEqual([
      'a.txt',
      'big.bin',
    ]);
  });

  it('a symlinked folder stays idle after its parent listing and loads its contents on demand', async () => {
    await put('real/sub/f.txt', 'f');
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    const h = make();
    const fs = httpAdapter('http://t/api/files', {
      fetch: ((u: string, i?: RequestInit) => h(new Request(u, i))) as typeof fetch,
    });
    const s = createTreeStore({ ...fs, watch: undefined });
    await s.loadFolder('');
    const t = (): ReturnType<typeof s.getSnapshot>['tree'] => s.getSnapshot().tree;
    expect(statusOf(t(), 'real')).toBe('loaded');
    expect(statusOf(t(), 'alias')).toBe('idle');
    await s.loadFolder('alias');
    expect(statusOf(t(), 'alias')).toBe('loaded');
    expect([...t().folders.get('alias')!.children.keys()]).toEqual(['sub']);
    expect([...t().folders.get('alias/sub')!.children.keys()]).toEqual(['f.txt']);
    s.dispose();
  });
});

describe('a store without a root directory', () => {
  it('answers a generic 500 and reports the detail only to onError', async () => {
    const onError = vi.fn();
    const handler = make({ store: nodeFsStore(undefined as unknown as string), onError });
    const response = await handler(new Request(url('list', { path: '' })));
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain('internal error');
    expect(body).not.toContain('AGENT_WORKSPACE_DIR');
    expect(String(onError.mock.calls[0]?.[0])).toContain('AGENT_WORKSPACE_DIR');
  });
});
