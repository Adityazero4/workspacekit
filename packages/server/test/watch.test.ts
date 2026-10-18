import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@scope/core';
import type { ChangeEvent, ErrorBody } from '@scope/core';
import { httpAdapter } from '@scope/core/http';
import { createFileHandler, nodeFsStore, type FileHandlerOptions, type FileStore } from '../src';
import { createWatcher } from '../src/watch';

// Wrap fs.watch so tests can count the OS watchers the store opens and closes.
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof import('node:fs')>();
  return {
    ...m,
    default: m,
    watch: vi.fn((...a: Parameters<typeof m.watch>) => {
      const w = m.watch(...a);
      vi.spyOn(w, 'close');
      return w;
    }),
  };
});
const fsWatch = async () => vi.mocked((await import('node:fs')).watch);

const enc = new TextEncoder();
const dec = new TextDecoder();
const H = { [CSRF_HEADER]: '1' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Time for the OS watcher to be armed before the test touches the disk. */
const armed = (): Promise<void> => sleep(250);

let base: string;
let root: string;
let store: FileStore;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-')));
  root = path.join(base, 'srv'); // not 'root': macOS may also report the watched directory itself under its own name
  await mkdir(root);
  await sleep(150); // macOS replays recent events of the new directory to a watcher started right away
  store = nodeFsStore(root, { exclude: ['.git'] });
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(base, { recursive: true, force: true });
});

const make = (o: Partial<FileHandlerOptions> = {}): ((req: Request) => Promise<Response>) =>
  createFileHandler({ store, authorize: () => true, ...o });
const watchReq = (signal?: AbortSignal): Request =>
  new Request('http://t/api/files/watch', { headers: { Accept: 'text/event-stream' }, ...(signal ? { signal } : {}) });
const disk = (p: string, text = 'x'): Promise<void> => writeFile(path.join(root, p), text);

/** Reads an SSE body and hands out parsed pieces: data frames and comment lines. */
function sse(res: Response): {
  frame(ms?: number): Promise<ChangeEvent[]>;
  raw(ms?: number): Promise<string>;
  until(n: number, ms?: number): Promise<ChangeEvent[][]>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
} {
  const reader = res.body!.getReader();
  let buf = '';
  let ended = false;
  const more = async (ms: number): Promise<void> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error('sse timeout')), ms)));
    const r = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(t));
    if (r.done) ended = true;
    else buf += dec.decode(r.value, { stream: true });
  };
  const rawChunk = async (ms = 3000): Promise<string> => {
    while (!buf.includes('\n\n')) {
      if (ended) throw new Error('stream ended');
      await more(ms);
    }
    const i = buf.indexOf('\n\n') + 2;
    const out = buf.slice(0, i);
    buf = buf.slice(i);
    return out;
  };
  const frame = async (ms = 3000): Promise<ChangeEvent[]> => {
    for (;;) {
      const c = await rawChunk(ms);
      if (c.startsWith('data: ')) return JSON.parse(c.slice(6, -2)) as ChangeEvent[];
    }
  };
  return {
    reader,
    raw: rawChunk,
    frame,
    async until(n, ms = 5000) {
      const frames: ChangeEvent[][] = [];
      let total = 0;
      while (total < n) {
        const f = await frame(ms);
        frames.push(f);
        total += f.length;
      }
      return frames;
    },
  };
}

/** A store whose watch is driven by the test. */
function fake(): { store: FileStore; emit(e: ChangeEvent[]): void; subs: () => number; unsubs: () => number } {
  let cbs: ((e: ChangeEvent[]) => void)[] = [];
  let off = 0;
  return {
    store: {
      ...store,
      watch(cb) {
        cbs.push(cb);
        return () => {
          off++;
          cbs = cbs.filter((c) => c !== cb);
        };
      },
    },
    emit: (e) => cbs.forEach((c) => c(e)),
    subs: () => cbs.length,
    unsubs: () => off,
  };
}

describe('watch route over a real directory', () => {
  it('external file write produces one updated batch with actor external', async () => {
    await disk('a.txt', 'one');
    const res = await make()(watchReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const s = sse(res);
    await armed();
    await disk('a.txt', 'two!');
    const events = await s.frame();
    expect(events).toEqual([{ type: 'updated', path: 'a.txt', mtimeMs: expect.any(Number), actor: 'external' }]);
    await s.reader.cancel();
  });

  it('writing 1,000 files in a loop arrives in <= 5 batches', async () => {
    const res = await make()(watchReq());
    const s = sse(res);
    await armed();
    await mkdir(path.join(root, 'many'));
    for (let i = 0; i < 1000; i++) await disk(`many/f${i}.txt`, String(i));
    const frames = await s.until(1000, 10_000);
    const paths = new Set(frames.flat().map((e) => e.path));
    for (let i = 0; i < 1000; i++) expect(paths.has(`many/f${i}.txt`)).toBe(true);
    expect(frames.length).toBeLessThanOrEqual(5);
    await s.reader.cancel();
  });

  it('write through handler is tagged actor user (and created, with parents)', async () => {
    const h = make();
    const s = sse(await h(watchReq()));
    await armed();
    const put = await h(new Request('http://t/api/files/write?path=d/new.txt', { method: 'PUT', headers: H, body: 'hello' }));
    expect(put.status).toBe(200);
    const seen: ChangeEvent[] = [];
    while (!seen.some((e) => e.path === 'd/new.txt')) seen.push(...(await s.frame()));
    expect(seen.find((e) => e.path === 'd/new.txt')).toMatchObject({ type: 'created', actor: 'user' });
    expect(seen.every((e) => e.actor === 'user')).toBe(true); // the parent directory too
    await s.reader.cancel();
  });

  it('actor is per watcher: the writer sees user, another principal sees external', async () => {
    const who = (r: Request): string => r.headers.get('x-who') ?? 'user';
    const h = make({ actor: who });
    const open = async (name: string) => sse(await h(new Request('http://t/api/files/watch', { headers: { 'x-who': name } })));
    const alice = await open('alice');
    const bob = await open('bob');
    await armed();
    const create = (name: string): Promise<Response> =>
      h(new Request('http://t/api/files/create', { method: 'POST', headers: { ...H, 'x-who': name, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'x.txt', kind: 'file' }) }));
    expect((await create('alice')).status).toBe(200);
    const mine = (await alice.frame()).find((e) => e.path === 'x.txt');
    const theirs = (await bob.frame()).find((e) => e.path === 'x.txt');
    expect(mine?.actor).toBe('user');
    expect(theirs?.actor).toBe('external'); // never another principal's label
    await alice.reader.cancel();
    await bob.reader.cancel();
  });

  it('attribution is limited to what the mutation touched, not everything below it', async () => {
    const h = make();
    const s = sse(await h(watchReq()));
    await armed();
    await h(new Request('http://t/api/files/create', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'dir', kind: 'directory' }) }));
    await disk('dir/other.txt', 'outside change'); // inside the created directory, within 2 s, not written through the handler
    const seen: ChangeEvent[] = [];
    while (!seen.some((e) => e.path === 'dir/other.txt')) seen.push(...(await s.frame()));
    expect(seen.find((e) => e.path === 'dir')?.actor).toBe('user');
    expect(seen.find((e) => e.path === 'dir/other.txt')?.actor).toBe('external');
    await s.reader.cancel();
  });

  it('children of a directory moved through the handler are attributed to the writer', async () => {
    await mkdir(path.join(root, 'a'));
    await disk('a/x.txt');
    await sleep(150); // let macOS settle so it does not replay the setup
    const h = make();
    const s = sse(await h(watchReq()));
    await armed();
    const res = await h(new Request('http://t/api/files/move', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'a', to: 'b' }) }));
    expect(res.status).toBe(200);
    const seen: ChangeEvent[] = [];
    while (!seen.some((e) => e.path === 'b')) seen.push(...(await s.frame()));
    await sleep(150);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((e) => e.path === 'a' || e.path === 'b' || e.path.startsWith('a/') || e.path.startsWith('b/')).every((e) => e.actor === 'user')).toBe(true);
    await s.reader.cancel();
  });

  it('a deleted top-level entry named like the root folder is reported', async () => {
    const name = path.basename(root);
    await disk(name, 'same name as the root');
    const s = sse(await make()(watchReq()));
    await armed();
    await rm(path.join(root, name));
    const seen: ChangeEvent[] = [];
    while (!seen.some((e) => e.path === name && e.type === 'deleted')) seen.push(...(await s.frame()));
    await s.reader.cancel();
  });

  it('excluded, temp and escaping paths are never emitted; names are NFC', async () => {
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'out'));
    const h = make();
    const s = sse(await h(watchReq()));
    await armed();
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.GIT2'));
    await disk('.git/config');
    await disk('.GIT/other'); // same directory on case-insensitive disks, a fresh one elsewhere
    await disk('.report.md.0123456789ab.tmp');
    await writeFile(path.join(outside, 'secret.txt'), 'x');
    await disk('out/secret2.txt');
    await disk('café.txt');
    await disk('visible.txt');
    const seen: ChangeEvent[] = [];
    while (!(seen.some((e) => e.path === 'visible.txt') && seen.some((e) => e.path === 'café.txt'))) seen.push(...(await s.frame()));
    await sleep(150);
    const paths = seen.map((e) => e.path);
    expect(paths.filter((p) => /(^|\/)\.git(\/|$)|\.tmp$|^out\//i.test(p))).toEqual([]);
    expect(paths.every((p) => p === p.normalize('NFC') && !p.startsWith('/') && !p.includes('..'))).toBe(true);
    await s.reader.cancel();
  });

  it('SSE response streams frames and stops on abort', async () => {
    const spy = fake();
    const ac = new AbortController();
    const res = await make({ store: spy.store })(watchReq(ac.signal));
    const s = sse(res);
    expect(spy.subs()).toBe(1);
    spy.emit([{ type: 'updated', path: 'a' }]);
    expect(await s.frame()).toEqual([{ type: 'updated', path: 'a', actor: 'external' }]);
    ac.abort();
    await vi.waitFor(() => expect(spy.unsubs()).toBe(1));
    expect(spy.subs()).toBe(0);
    await expect(s.reader.read()).resolves.toMatchObject({ done: true });
  });

  it('httpAdapter(..., {fetch}).watch receives the batches end to end', async () => {
    const h = make();
    const adapter = httpAdapter('http://t/api/files', { fetch: (input, init) => h(new Request(input, init)) });
    const got: ChangeEvent[][] = [];
    const off = adapter.watch!((e) => got.push(e));
    await armed();
    await disk('e2e.txt');
    await vi.waitFor(() => expect(got.flat().some((e) => e.path === 'e2e.txt')).toBe(true), { timeout: 5000 });
    off();
  });
});

describe('shared fs.watch', () => {
  it('one fs.watch serves all subscribers, closes with the last one and restarts on demand', async () => {
    const fw = await fsWatch();
    fw.mockClear();
    const a: ChangeEvent[][] = [];
    const b: ChangeEvent[][] = [];
    const offA = store.watch!((e) => a.push(e));
    const offB = store.watch!((e) => b.push(e));
    expect(fw).toHaveBeenCalledTimes(1);
    expect(fw.mock.calls[0]![1]).toMatchObject({ recursive: true });
    await armed();
    await disk('s.txt');
    await vi.waitFor(() => expect(a.flat().length + b.flat().length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(a.flat().map((e) => e.path)).toEqual(b.flat().map((e) => e.path));
    const w = fw.mock.results[0]!.value;
    offA();
    expect(w.close).not.toHaveBeenCalled();
    offB();
    offB(); // idempotent
    expect(w.close).toHaveBeenCalledTimes(1);
    const off2 = store.watch!(() => {});
    expect(fw).toHaveBeenCalledTimes(2);
    off2();
  });

  it('leaves no timers after the last subscriber leaves, even with a flush pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const off = store.watch!(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await disk('t.txt'); // real fs event arrives -> debounce timer
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0), { timeout: 3000, interval: 10 });
    off();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createWatcher', () => {
  it('delivers to a new subscriber after the last one left during a slow flush', async () => {
    const src = {
      root,
      hiddenName: () => false,
      async probe(rel: string) {
        if (rel === 'one') await sleep(600);
        return { mtimeMs: 1, birthMs: 0 };
      },
    };
    const subscribe = createWatcher(src);
    const offA = subscribe(() => {});
    await armed();
    await disk('one');
    await sleep(150); // the flush is probing now
    offA();
    const got: ChangeEvent[] = [];
    const offB = subscribe((e) => got.push(...e));
    await armed();
    await disk('two');
    await vi.waitFor(() => expect(got.map((e) => e.path)).toContain('two'), { timeout: 3000 });
    offB();
  });
});

describe('watch route framing, backpressure and lifecycle', () => {
  const ev = (i: number): ChangeEvent => ({ type: 'updated', path: `dir/some-long-file-name-${i}.txt`, mtimeMs: 1_700_000_000_000 + i, actor: 'external' });

  it('splits 10,000 events into frames under 512 KiB, in order', async () => {
    const spy = fake();
    const s = sse(await make({ store: spy.store })(watchReq()));
    const all = Array.from({ length: 10_000 }, (_, i) => ev(i));
    spy.emit(all);
    const frames: string[] = [];
    let count = 0;
    while (count < 10_000) {
      const c = await s.raw();
      if (c === ': ping\n\n') continue;
      expect(c.startsWith('data: ')).toBe(true);
      frames.push(c);
      count += (JSON.parse(c.slice(6, -2)) as unknown[]).length;
    }
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(enc.encode(f).byteLength).toBeLessThan(512 * 1024);
    expect(frames.flatMap((f) => JSON.parse(f.slice(6, -2)) as ChangeEvent[])).toEqual(all);
    await s.reader.cancel();
    expect(spy.unsubs()).toBe(1);
  });

  it('closes a client whose stream is not draining instead of buffering unboundedly', async () => {
    const spy = fake();
    const res = await make({ store: spy.store })(watchReq());
    const batch = Array.from({ length: 10_000 }, (_, i) => ev(i)); // ~1.1 MB
    for (let i = 0; i < 6; i++) spy.emit(batch); // never read: the 4 MiB budget fills during the 4th batch
    expect(spy.unsubs()).toBe(1);
    expect(spy.subs()).toBe(0);
    const reader = res.body!.getReader();
    let bytes = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
    }
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });

  it('re-checks the byte budget before every frame, so one batch cannot overshoot it', async () => {
    const spy = fake();
    const res = await make({ store: spy.store })(watchReq());
    const big = Array.from({ length: 10_000 }, (_, i): ChangeEvent => ({ type: 'updated', path: `${'x'.repeat(1000)}${i}` })); // ~10 MB
    spy.emit(big);
    expect(spy.unsubs()).toBe(1);
    const reader = res.body!.getReader();
    let bytes = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
    }
    expect(bytes).toBeLessThan(4 * 1024 * 1024 + 600 * 1024);
  });

  it('replaces a batch of more than 10,000 events by one resync event', async () => {
    const spy = fake();
    const s = sse(await make({ store: spy.store })(watchReq()));
    spy.emit(Array.from({ length: 10_001 }, (_, i) => ev(i)));
    expect(await s.frame()).toEqual([{ type: 'resync', path: '' }]);
    spy.emit([ev(1)]);
    expect((await s.frame()).length).toBe(1);
    await s.reader.cancel();
  });

  it('sends a ping immediately on connect', async () => {
    const spy = fake();
    const s = sse(await make({ store: spy.store })(watchReq()));
    expect(await s.raw()).toBe(': ping\n\n');
    await s.reader.cancel();
  });

  it('sends a ": ping" heartbeat per client and clears its timer on cancel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const spy = fake();
    const s = sse(await make({ store: spy.store, watchHeartbeatMs: 25_000 })(watchReq()));
    expect(vi.getTimerCount()).toBe(1);
    expect(await s.raw()).toBe(': ping\n\n'); // the connect ping
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await s.raw()).toBe(': ping\n\n');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await s.raw()).toBe(': ping\n\n');
    await s.reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect(spy.unsubs()).toBe(1);
  });

  it('defaults the heartbeat to 25 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const spy = fake();
    const s = sse(await make({ store: spy.store })(watchReq()));
    expect(await s.raw()).toBe(': ping\n\n'); // the connect ping
    await vi.advanceTimersByTimeAsync(24_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await s.raw()).toBe(': ping\n\n');
    await s.reader.cancel();
  });

  it('an already aborted request subscribes to nothing', async () => {
    const spy = fake();
    const ac = new AbortController();
    ac.abort();
    await make({ store: spy.store })(watchReq(ac.signal)).catch(() => {});
    expect(spy.subs()).toBe(0);
  });

  it('asks authorize(req, "watch", "") first and answers 403 without subscribing', async () => {
    const spy = fake();
    const authorize = vi.fn((_r: Request, op: string) => op !== 'watch');
    const res = await make({ store: spy.store, authorize })(watchReq());
    expect(res.status).toBe(403);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), 'watch', '');
    expect(spy.subs()).toBe(0);
  });

  it('answers 503 with Retry-After when fs.watch cannot start, and the rest keeps working', async () => {
    const broken: FileStore = {
      ...store,
      watch() {
        throw new Error('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
      },
    };
    const h = make({ store: broken });
    const res = await h(watchReq());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    const body = (await res.json()) as ErrorBody;
    expect(body.error.kind).toBe('unknown');
    expect(body.error.message).toMatch(/live updates are unavailable/i);
    expect((await h(new Request('http://t/api/files/list'))).status).toBe(200);
  });

  it('answers 501 when the store has no watch', async () => {
    const { watch: _w, ...rest } = store;
    const res = await make({ store: rest })(watchReq());
    expect(res.status).toBe(501);
  });

  it('closes the client stream when the shared watcher fails', async () => {
    let fail: (e: Error) => void = () => {};
    const s0: FileStore = { ...store, watch: (_cb, onError) => ((fail = onError!), () => {}) };
    const s = sse(await make({ store: s0 })(watchReq()));
    fail(new Error('boom'));
    let r = await s.reader.read();
    while (!r.done) r = await s.reader.read(); // the connect ping, then the end
    expect(r.done).toBe(true);
  });
});
