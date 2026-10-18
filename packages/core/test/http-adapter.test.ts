import { expect, test, vi } from 'vitest';
import { httpAdapter } from '../src/http';
import { FsError } from '../src/errors';
import { CSRF_HEADER, IF_MTIME_HEADER } from '../src/protocol';
import type { ChangeEvent } from '../src/types';

const BASE = 'http://x.test/api';
type Handler = (req: Request) => Response | Promise<Response>;
function stub(handler: Handler): { fetch: typeof fetch; reqs: Request[] } {
  const reqs: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    reqs.push(req);
    return handler(req);
  }) as typeof fetch;
  return { fetch: f, reqs };
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('encodes path as query param', async () => {
  const s = stub(() => json({ entry: null }));
  const fs = httpAdapter(BASE, { fetch: s.fetch });
  await fs.stat!('/a b/#1%.md/');
  const u = new URL(s.reqs[0]!.url);
  expect(u.pathname).toBe('/api/stat');
  expect(u.searchParams.get('path')).toBe('a b/#1%.md');
});

test('maps 409 ErrorBody to FsError conflict', async () => {
  const s = stub(() => json({ error: { kind: 'conflict', message: 'exists', path: 'a' } }, 409));
  const fs = httpAdapter(BASE, { fetch: s.fetch });
  const err = await fs.create!('a', 'file').catch((e) => e);
  expect(err).toBeInstanceOf(FsError);
  expect(err).toMatchObject({ kind: 'conflict', status: 409, path: 'a', message: 'exists' });
  // non-JSON body falls back to status mapping
  const s2 = stub(() => new Response('nope', { status: 404 }));
  const err2 = await httpAdapter(BASE, { fetch: s2.fetch }).delete!('a').catch((e) => e);
  expect(err2).toMatchObject({ kind: 'not_found', status: 404 });
});

test('maps fetch TypeError to network and AbortError to cancelled', async () => {
  const net = httpAdapter(BASE, { fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
  expect(await net.list('', { depth: 1 }).catch((e) => e)).toMatchObject({ kind: 'network' });
  const ac = new AbortController();
  const abortable = httpAdapter(BASE, {
    fetch: ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, rej) => {
        const fail = (): void => rej(new DOMException('x', 'AbortError'));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener('abort', fail);
      })) as typeof fetch,
  });
  const p = abortable.list('', { depth: 1, signal: ac.signal }).catch((e) => e);
  ac.abort();
  expect(await p).toMatchObject({ kind: 'cancelled' });
});

test('write sends If-Mtime-Ms when expectedMtimeMs given', async () => {
  const s = stub(() => json({ entry: { path: 'a', name: 'a', kind: 'file' } }));
  const fs = httpAdapter(BASE, { fetch: s.fetch });
  await fs.write!('a', 'hello', { expectedMtimeMs: 42 });
  await fs.write!('a', 'again');
  expect(s.reqs[0]!.method).toBe('PUT');
  expect(s.reqs[0]!.headers.get(IF_MTIME_HEADER)).toBe('42');
  expect(await s.reqs[0]!.text()).toBe('hello');
  expect(s.reqs[1]!.headers.has(IF_MTIME_HEADER)).toBe(false);
});

test('every non-GET request carries the CSRF header, GET requests do not need it', async () => {
  const entry = { path: 'b', name: 'b', kind: 'file' };
  const s = stub((req) => {
    const p = new URL(req.url).pathname;
    if (p.endsWith('/download')) return new Response('zip');
    if (p.endsWith('/list') || p.endsWith('/search')) return json({ entries: [] });
    if (p.endsWith('/init')) return json({ uploadId: 'u', chunkSize: 4 });
    if (p.endsWith('/delete') || p.endsWith('/chunk') || (p.endsWith('/upload') && req.method === 'DELETE')) return new Response(null, { status: 204 });
    return json({ entry });
  });
  const fs = httpAdapter(BASE, { fetch: s.fetch, headers: { 'X-T': '1' } });
  const ac = new AbortController();
  await fs.list('', { depth: 1 });
  await fs.stat!('a');
  await fs.read('a', 'text');
  await fs.search!('q');
  await fs.create!('a', 'file');
  await fs.write!('a', 'x');
  await fs.move!('a', 'b');
  await fs.copy!('a', 'b');
  await fs.delete!('a');
  await fs.download!(['a']);
  await fs.upload!.direct('a', new Blob(['x']), { signal: ac.signal });
  const c = fs.upload!.chunked!;
  const { uploadId } = await c.init('a', 1);
  await c.put(uploadId, 0, 0, new Blob(['x']), ac.signal);
  await c.complete(uploadId);
  await c.abort(uploadId);
  expect(s.reqs).toHaveLength(15);
  for (const r of s.reqs) {
    expect(r.headers.get(CSRF_HEADER), `${r.method} ${r.url}`).toBe(r.method === 'GET' ? null : '1');
    expect(r.headers.get('x-t')).toBe('1');
  }
});

test('read returns text, blob and arrayBuffer', async () => {
  const s = stub(() => new Response('héllo'));
  const fs = httpAdapter(BASE, { fetch: s.fetch });
  expect(await fs.read('a', 'text')).toBe('héllo');
  expect((await fs.read('a', 'blob')).size).toBe(6);
  expect((await fs.read('a', 'arrayBuffer')).byteLength).toBe(6);
});

test('json endpoints, move/copy and download', async () => {
  const entry = { path: 'b', name: 'b', kind: 'file' };
  const s = stub((req) => {
    const p = new URL(req.url).pathname;
    if (p.endsWith('/download')) return new Response('zip', { headers: { 'content-type': 'application/zip' } });
    if (p.endsWith('/list') || p.endsWith('/search')) return json({ entries: [entry] });
    return p.endsWith('/delete') ? new Response(null, { status: 204 }) : json({ entry });
  });
  const fs = httpAdapter(BASE, { fetch: s.fetch });
  expect(await fs.list('/x/', { depth: 2 })).toEqual([entry]);
  expect(await fs.search!('q')).toEqual([entry]);
  expect(await fs.move!('a/', '/b', { overwrite: true })).toEqual(entry);
  expect(await fs.copy!('a', 'b')).toEqual(entry);
  await fs.delete!('b');
  const blob = (await fs.download!(['a', '/b/'])) as Blob;
  expect(await blob.text()).toBe('zip');
  const [list, , move, copy, , dl] = s.reqs;
  expect(new URL(list!.url).searchParams.get('depth')).toBe('2');
  expect(await move!.json()).toEqual({ from: 'a', to: 'b', overwrite: true });
  expect(await copy!.json()).toEqual({ from: 'a', to: 'b' });
  expect(await dl!.json()).toEqual({ paths: ['a', 'b'] });
});

test('headers option may be async and is applied to every request including watch', async () => {
  let n = 0;
  const s = stub((req) =>
    new URL(req.url).pathname.endsWith('/watch') ? new Response(new ReadableStream({ start: () => {} })) : json({ entries: [] }),
  );
  const fs = httpAdapter(BASE, {
    fetch: s.fetch,
    reconnectDelaysMs: [0],
    headers: async () => ({ Authorization: `Bearer t${++n}` }),
  });
  await fs.list('', { depth: 1 });
  await fs.search!('q');
  const stop = fs.watch!(() => {});
  await expect.poll(() => s.reqs.length).toBe(3);
  stop();
  expect(s.reqs.map((r) => r.headers.get('authorization'))).toEqual(['Bearer t1', 'Bearer t2', 'Bearer t3']);
});

test('watch parses multi-line SSE frames, ignores comments, reconnects after stream end', async () => {
  const enc = new TextEncoder();
  const ev = (path: string): ChangeEvent => ({ type: 'created', path });
  const frames = [ev('a'), ev('b')];
  const json1 = JSON.stringify(frames);
  const half = Math.floor(json1.length / 2);
  // stream 1: comment, a frame split mid-line across chunks with CRLF, and a multi-line data frame
  const chunks1 = [
    ': keepalive\r\n\r\n',
    `data: ${json1.slice(0, half)}`,
    `${json1.slice(half)}\r`,
    '\n\r\n',
    'data: [{"type":"updated",\ndata: "path":"c"}]\n\n',
  ];
  const streams: (string[] | 'hang')[] = [chunks1, ['data: [{"type":"deleted","path":"d"}]\n\n'], 'hang'];
  let call = 0;
  const s = stub(() => {
    const spec = streams[call++]!;
    return new Response(
      spec === 'hang'
        ? new ReadableStream({ start: () => {} })
        : new ReadableStream({
            start(c) {
              for (const ch of spec) c.enqueue(enc.encode(ch));
              c.close();
            },
          }),
    );
  });
  const got: ChangeEvent[][] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0] }).watch!((e) => got.push(e));
  await expect.poll(() => got.length).toBe(5);
  const resync = [{ type: 'resync', path: '' }];
  // the first connect delivers no resync; every re-connect delivers one before its frames
  expect(got).toEqual([frames, [{ type: 'updated', path: 'c' }], resync, [{ type: 'deleted', path: 'd' }], resync]);
  await expect.poll(() => s.reqs.length).toBe(3);
  stop();
  await new Promise((r) => setTimeout(r, 20));
  expect(s.reqs.length).toBe(3); // no reconnect after unsubscribe
});

test('watch reconnects after fetch errors and stops cleanly on unsubscribe', async () => {
  let calls = 0;
  const f = (async (_u: unknown, init?: RequestInit) => {
    calls++;
    throw init?.signal?.aborted ? new DOMException('x', 'AbortError') : new TypeError('down');
  }) as typeof fetch;
  const stop = httpAdapter(BASE, { fetch: f, reconnectDelaysMs: [0] }).watch!(() => {});
  await expect.poll(() => calls).toBeGreaterThan(2);
  stop();
  await new Promise((r) => setTimeout(r, 10));
  const after = calls;
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toBe(after);
});

test('url() includes version and credentials flag', () => {
  const e = { path: 'a b/c.png', name: 'c.png', kind: 'file' as const, mtimeMs: 123 };
  expect(httpAdapter(BASE + '/').url!(e)).toEqual({
    url: `${BASE}/read?path=a+b%2Fc.png&v=123`,
    withCredentials: false,
  });
  expect(httpAdapter(BASE, { credentials: 'include' }).url!(e)).toMatchObject({ withCredentials: true });
});

test('upload: direct via fetch, chunked init/put/complete/abort', async () => {
  const entry = { path: 'd/f.txt', name: 'f.txt', kind: 'file' };
  const s = stub((req) => {
    const p = new URL(req.url).pathname;
    if (p.endsWith('/upload/init')) return json({ uploadId: 'u1', chunkSize: 4 });
    if (p.endsWith('/upload/chunk') || (p.endsWith('/upload') && req.method === 'DELETE')) return new Response(null, { status: 204 });
    return json({ entry });
  });
  const up = httpAdapter(BASE, { fetch: s.fetch }).upload!;
  const progress: number[] = [];
  const file = new Blob(['hello']);
  expect(await up.direct('/d/f.txt', file, { signal: new AbortController().signal, onProgress: (n) => progress.push(n), overwrite: true })).toEqual(entry);
  expect(progress).toEqual([5]);
  const u = new URL(s.reqs[0]!.url);
  expect(u.pathname).toBe('/api/upload');
  expect(u.searchParams.get('path')).toBe('d/f.txt');
  expect(u.searchParams.get('overwrite')).toBe('1');
  expect(await s.reqs[0]!.text()).toBe('hello');

  const ch = up.chunked!;
  expect(await ch.init('d/f.txt', 5, { overwrite: true })).toEqual({ uploadId: 'u1', chunkSize: 4 });
  expect(await s.reqs[1]!.json()).toEqual({ path: 'd/f.txt', totalBytes: 5, overwrite: true });
  await ch.put('u1', 1, 4, new Blob(['o']), new AbortController().signal);
  const cu = new URL(s.reqs[2]!.url);
  expect([cu.searchParams.get('id'), cu.searchParams.get('index'), cu.searchParams.get('offset')]).toEqual(['u1', '1', '4']);
  expect(await ch.complete('u1')).toEqual(entry);
  await ch.abort('u1');
  expect(s.reqs[4]!.method).toBe('DELETE');
  expect(new URL(s.reqs[4]!.url).searchParams.get('id')).toBe('u1');
});

test('watch: a throwing listener does not drop frames or reconnect', async () => {
  const enc = new TextEncoder();
  const s = stub(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: [{"type":"created","path":"a"}]\n\ndata: [{"type":"created","path":"b"}]\n\n'));
          },
        }),
      ),
  );
  const got: string[] = [];
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown): void => void uncaught.push(e);
  const proc = (globalThis as unknown as { process: { on(e: string, f: (x: unknown) => void): void; off(e: string, f: (x: unknown) => void): void } }).process;
  proc.on('uncaughtException', onUncaught);
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0] }).watch!((ev) => {
    got.push(ev[0]!.path);
    if (got.length === 1) throw new Error('bad listener');
  });
  await expect.poll(() => got.length).toBe(2);
  await expect.poll(() => uncaught.length).toBe(1); // reported out-of-band
  stop();
  proc.off('uncaughtException', onUncaught);
  expect(got).toEqual(['a', 'b']);
  expect(s.reqs.length).toBe(1);
});

class FakeXhr {
  static last: FakeXhr | undefined;
  static count = 0;
  upload: { onprogress?: (e: { loaded: number }) => void } = {};
  withCredentials = false;
  status = 0;
  responseText = '';
  headers: Record<string, string> = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  method = '';
  url = '';
  sent: unknown;
  constructor() {
    FakeXhr.last = this;
    FakeXhr.count++;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  send(body: unknown): void {
    this.sent = body;
  }
  abort(): void {
    this.onabort?.();
  }
  finish(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

async function withXhr(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { XMLHttpRequest?: unknown };
  const prev = g.XMLHttpRequest;
  g.XMLHttpRequest = FakeXhr;
  FakeXhr.last = undefined;
  FakeXhr.count = 0;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete g.XMLHttpRequest;
    else g.XMLHttpRequest = prev;
  }
}

test('xhr upload: progress, success, conflict, mid-flight abort, pre-aborted', () =>
  withXhr(async () => {
    const entry = { path: 'a.txt', name: 'a.txt', kind: 'file' };
    const up = httpAdapter(BASE, { credentials: 'include', headers: async () => ({ 'X-T': '1' }) }).upload!;
    const file = new Blob(['hello'], { type: 'text/plain' });

    const progress: number[] = [];
    const ok = up.direct('/a.txt', file, { signal: new AbortController().signal, onProgress: (n) => progress.push(n), overwrite: true });
    await expect.poll(() => FakeXhr.last?.sent).toBe(file);
    const x = FakeXhr.last!;
    expect(x.method).toBe('POST');
    expect(x.url).toBe(`${BASE}/upload?path=a.txt&overwrite=1`);
    expect(x.withCredentials).toBe(true);
    expect(x.headers).toMatchObject({ 'x-t': '1', 'content-type': 'text/plain', 'x-fs-request': '1' });
    x.upload.onprogress!({ loaded: 2 });
    x.upload.onprogress!({ loaded: 5 });
    x.finish(200, { entry });
    expect(await ok).toEqual(entry);
    expect(progress).toEqual([2, 5]);

    const conflict = up.direct('a.txt', file, { signal: new AbortController().signal });
    await expect.poll(() => FakeXhr.last?.sent).toBe(file);
    FakeXhr.last!.finish(409, { error: { kind: 'conflict', message: 'exists' } });
    expect(await conflict.catch((e) => e)).toMatchObject({ kind: 'conflict', status: 409 });

    const ac = new AbortController();
    const mid = up.direct('a.txt', file, { signal: ac.signal }).catch((e) => e);
    await expect.poll(() => FakeXhr.last?.sent).toBe(file);
    ac.abort();
    expect(await mid).toMatchObject({ kind: 'cancelled' });

    const before = FakeXhr.count;
    const pre = new AbortController();
    pre.abort();
    expect(await up.direct('a.txt', file, { signal: pre.signal }).catch((e) => e)).toMatchObject({ kind: 'cancelled' });
    expect(FakeXhr.count).toBe(before); // no XHR created
  }));

const sse = (...chunks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
  );
const hang = (): Response => new Response(new ReadableStream({ start: () => {} }));
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('drops the connection when a line exceeds 1 MiB without a terminator', async () => {
  let cancelled = false;
  let call = 0;
  const s = stub(() =>
    ++call > 1
      ? hang()
      : new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('x'.repeat(1_048_576 + 1)));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
  );
  const got: unknown[] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0] }).watch!((e) => got.push(e));
  await expect.poll(() => s.reqs.length).toBe(2);
  stop();
  expect(cancelled).toBe(true);
  expect(got).toEqual([[{ type: 'resync', path: '' }]]); // only the re-connect's resync, nothing from the dropped stream
});

test("drops the connection when one frame's data exceeds 1 MiB", async () => {
  const line = `data: ${'y'.repeat(1000)}\n`;
  const big = line.repeat(1100) + '\n'; // > 1 MiB of data before the blank line
  let call = 0;
  let cancelled = false;
  const s = stub(() =>
    ++call > 1
      ? hang()
      : new Response( // stays open: only the adapter can end this connection
          new ReadableStream({
            start(c) {
              for (const part of big.match(/[^]{1,50000}/g)!) c.enqueue(new TextEncoder().encode(part));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
  );
  const got: unknown[] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0] }).watch!((e) => got.push(e));
  await expect.poll(() => s.reqs.length).toBe(2);
  stop();
  expect(cancelled).toBe(true);
  expect(got).toEqual([[{ type: 'resync', path: '' }]]); // only the re-connect's resync, nothing from the dropped stream
});

test('drops the connection on a flood of empty data: lines', async () => {
  const flood = 'data:\n'.repeat(1_048_576 + 1); // each line adds 0 chars of data but 1 joining newline
  let cancelled = false;
  let call = 0;
  const s = stub(() =>
    ++call > 1
      ? hang()
      : new Response(
          new ReadableStream({
            start(c) {
              for (const part of flood.match(/[^]{1,60000}/g)!) c.enqueue(new TextEncoder().encode(part));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
  );
  const got: unknown[] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0] }).watch!((e) => got.push(e));
  await expect.poll(() => s.reqs.length).toBe(2);
  stop();
  expect(cancelled).toBe(true);
  expect(got).toEqual([[{ type: 'resync', path: '' }]]); // only the re-connect's resync, nothing from the dropped stream
});

test.each([400, 404, 501])('stops and reports on %i', async (status) => {
  const s = stub(() => new Response('no', { status }));
  const errors: FsError[] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0], onWatchError: (e) => errors.push(e) }).watch!(() => {});
  await expect.poll(() => errors.length).toBe(1);
  await tick();
  stop();
  expect(s.reqs.length).toBe(1);
  expect(errors[0]).toBeInstanceOf(FsError);
  expect(errors[0]).toMatchObject({ status, kind: { 400: 'invalid', 404: 'not_found', 501: 'unknown' }[status] });
});

test('401 and 403 are reported each time and retried at the longest delay', async () => {
  const real = globalThis.setTimeout;
  const seen: number[] = [];
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 5 || ms === 7 || ms === 9) seen.push(ms);
    return real(fn, 0);
  }) as typeof setTimeout);
  try {
    const plan = [() => new Response('x', { status: 401 }), () => new Response('x', { status: 403 }), () => new Response('x', { status: 500 }), hang];
    let call = 0;
    const s = stub(() => plan[call++]!());
    const errors: FsError[] = [];
    const got: ChangeEvent[][] = [];
    const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [5, 9, 7], onWatchError: (e) => errors.push(e) }).watch!((e) => got.push(e));
    await expect.poll(() => s.reqs.length).toBe(4);
    stop();
    expect(errors.map((e) => e.status)).toEqual([401, 403]);
    expect(seen).toEqual([9, 9, 5]); // the 500 is an ordinary failure: normal backoff
  } finally {
    spy.mockRestore();
  }
});

test('keeps retrying 500/502/503 and network errors with backoff', async () => {
  const plan: (() => Response)[] = [
    () => new Response('x', { status: 500 }),
    () => new Response('x', { status: 502 }),
    () => new Response('x', { status: 503 }),
    () => { throw new TypeError('down'); },
    () => sse('data: [{"type":"created","path":"a"}]\n\n'),
  ];
  let call = 0;
  const s = stub(() => (plan[call++] ?? hang)());
  const errors: FsError[] = [];
  const got: ChangeEvent[][] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0], onWatchError: (e) => errors.push(e) }).watch!((e) => got.push(e));
  await expect.poll(() => got.length).toBe(3);
  stop();
  expect(got[1]).toEqual([{ type: 'created', path: 'a' }]); // after the first resync (the 5th attempt connected)
  expect(errors).toEqual([]);
});

test('backoff resets only after a complete frame', async () => {
  const real = globalThis.setTimeout;
  const seen: number[] = [];
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 5 || ms === 7) seen.push(ms);
    return real(fn, 0);
  }) as typeof setTimeout);
  try {
    // 1: ping only, 2: nothing, 3: a frame, 4: nothing, 5: stays open
    const plan = [() => sse(': ping\n\n'), () => sse(), () => sse('data: []\n\n'), () => sse(), hang];
    let call = 0;
    const s = stub(() => plan[call++]!());
    const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [5, 7] }).watch!(() => {});
    await expect.poll(() => s.reqs.length).toBe(5);
    stop();
    // no frame: 5 then 7; frame resets, so 5 again; then no frame: 7
    expect(seen).toEqual([5, 7, 5, 7]);
  } finally {
    spy.mockRestore();
  }
});

test('watch: a failed first attempt followed by a connect still resyncs', async () => {
  let calls = 0;
  const s = stub(() => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 503 });
    return new Response(new ReadableStream({ start: () => {} }));
  });
  const got: ChangeEvent[][] = [];
  const stop = httpAdapter(BASE, { fetch: s.fetch, reconnectDelaysMs: [0] }).watch!((e) => got.push(e));
  await expect.poll(() => got.length).toBe(1);
  expect(got[0]).toEqual([{ type: 'resync', path: '' }]);
  stop();

});
