import { describe, expect, it } from 'vitest';
import { FsError, isFsError } from '../src/errors';
import { createMemoryAdapter, type MemoryAdapter } from '../src/memory';
import type { UploadTransport } from '../src/types';
import * as root from '../src';
import { createUploader, type UploadItem, type UploadProgress } from '../src/upload/engine';
import { mapWithConcurrency } from '../src/upload/pool';
import { withRetry } from '../src/upload/retry';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const file = (name: string, content: string): UploadItem['file'] => Object.assign(new Blob([content]), { name });
const item = (relativePath: string, content: string): UploadItem => ({
  file: file(relativePath.split('/').pop()!, content),
  relativePath,
});

interface Deferred {
  resolve(): void;
}
/** Holds calls until `release()`; `peak` is the most calls ever held at once. */
function gate(): { hold(): Promise<void>; held: Deferred[]; peak(): number; release(): void } {
  const held: Deferred[] = [];
  let inflight = 0;
  let peak = 0;
  return {
    held,
    peak: () => peak,
    async hold() {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise<void>((resolve) => held.push({ resolve }));
      inflight--;
    },
    release() {
      for (const d of held.splice(0)) d.resolve();
    },
  };
}

/** Lets timers/microtasks run until `p` settles, releasing the gate each time everything is parked. */
async function drive<T>(p: Promise<T>, g: { release(): void }): Promise<T> {
  let done = false;
  const wrapped = p.finally(() => (done = true));
  while (!done) {
    await flush();
    g.release();
  }
  return wrapped;
}

function setup(files: Record<string, string> = {}, wrapTransport: (t: UploadTransport) => UploadTransport = (t) => t) {
  const fs: MemoryAdapter = createMemoryAdapter({ files, chunkSize: 4 });
  const transport = wrapTransport(fs.upload!);
  const uploader = createUploader({
    transport,
    exists: async (p) => (await fs.stat!(p)) !== null,
    remove: (p) => fs.delete!(p),
    retryDelaysMs: [0, 0, 0, 0],
    chunkRetryDelaysMs: [0, 0, 0],
    directThresholdBytes: 8,
  });
  return { fs, uploader };
}
const has = async (fs: MemoryAdapter, p: string): Promise<boolean> => (await fs.stat!(p)) !== null;
const text = (fs: MemoryAdapter, p: string): Promise<string> => fs.read(p, 'text');

describe('routing', () => {
  it('direct below threshold, chunked at or above; 0-byte file uploads directly', async () => {
    const calls: string[] = [];
    const { fs, uploader } = setup({}, (t) => ({
      direct: (...a) => (calls.push('direct'), t.direct(...a)),
      chunked: { ...t.chunked!, init: (...a) => (calls.push('init'), t.chunked!.init(...a)) },
    }));
    const r = await uploader.upload([item('empty', ''), item('small', '1234567'), item('big', '12345678')], 'd');
    expect(r.failed).toEqual([]);
    expect(calls.sort()).toEqual(['direct', 'direct', 'init']);
    expect(await text(fs, 'd/big')).toBe('12345678');
    expect(await text(fs, 'd/small')).toBe('1234567');
    expect(await text(fs, 'd/empty')).toBe('');
  });
});

describe('concurrency', () => {
  it('chunk concurrency never exceeds 6, file concurrency never exceeds 3', async () => {
    const puts = gate();
    const directs = gate();
    const { fs, uploader } = setup({}, (t) => ({
      direct: async (p, f, o) => (await directs.hold(), t.direct(p, f, o)),
      chunked: { ...t.chunked!, put: async (...a) => (await puts.hold(), t.chunked!.put(...a)) },
    }));
    const chunked = ['a', 'b', 'c', 'd'].map((n) => item(n, 'x'.repeat(40)));
    const rc = await drive(uploader.upload(chunked, ''), puts);
    expect(rc.uploaded).toHaveLength(4);
    expect(puts.peak()).toBe(6);
    expect(await text(fs, 'a')).toBe('x'.repeat(40));

    const small = ['1', '2', '3', '4', '5'].map((n) => item(`s${n}`, 'x'));
    const rd = await drive(uploader.upload(small, ''), directs);
    expect(rd.uploaded).toHaveLength(5);
    expect(directs.peak()).toBe(3);
  });
});

describe('retry', () => {
  it('retries transient errors only', async () => {
    let n = 0;
    const flaky = setup({}, (t) => ({
      ...t,
      chunked: {
        ...t.chunked!,
        put: (...a) => (++n === 1 ? Promise.reject(new FsError('network')) : t.chunked!.put(...a)),
      },
    }));
    const ok = await flaky.uploader.upload([item('f', '12345678')], '');
    expect(ok.uploaded).toHaveLength(1);
    expect(await text(flaky.fs, 'f')).toBe('12345678');

    let calls = 0;
    const denied = setup({}, (t) => ({
      ...t,
      direct: () => (calls++, Promise.reject(new FsError('forbidden'))),
    }));
    const bad = await denied.uploader.upload([item('f', 'x')], '');
    expect(calls).toBe(1);
    expect(bad.failed.map((f) => f.error.kind)).toEqual(['forbidden']);
  });

  it('withRetry: retries 502/503/504 and timeouts, gives up after the delays run out, never retries cancelled', async () => {
    let n = 0;
    const flaky = (): Promise<string> =>
      ++n < 3 ? Promise.reject(new FsError('unknown', 'x', { status: n === 1 ? 503 : 504 })) : Promise.resolve('ok');
    expect(await withRetry(flaky, [0, 0])).toBe('ok');
    n = 0;
    await expect(withRetry(() => (n++, Promise.reject(new FsError('timeout'))), [0, 0])).rejects.toMatchObject({ kind: 'timeout' });
    expect(n).toBe(3);
    n = 0;
    await expect(withRetry(() => (n++, Promise.reject(new FsError('cancelled'))), [0, 0])).rejects.toMatchObject({ kind: 'cancelled' });
    expect(n).toBe(1);
  });

  it('withRetry: backoff rejects promptly with cancelled when the signal aborts', async () => {
    const ctl = new AbortController();
    let n = 0;
    const p = withRetry(() => (n++, Promise.reject(new FsError('network'))), [3_600_000], ctl.signal);
    await flush();
    ctl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(n).toBe(1);
  });
});

describe('pool', () => {
  it('pool and retry helpers stay internal to the package', () => {
    expect(Object.keys(root)).not.toContain('mapWithConcurrency');
    expect(Object.keys(root)).not.toContain('withRetry');
  });

  it('mapWithConcurrency keeps order, settles every item and stops starting work after abort', async () => {
    const r = await mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('boom');
      return x * 10;
    });
    expect(r.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    const ctl = new AbortController();
    const started: number[] = [];
    const r2 = await mapWithConcurrency([1, 2, 3], 1, async (x) => (started.push(x), ctl.abort(), x), ctl.signal);
    expect(started).toEqual([1]);
    expect(r2.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
  });
});

describe('best effort and untrusted paths', () => {
  it('best effort: one permanent failure leaves the other four uploaded', async () => {
    const { fs, uploader } = setup({}, (t) => ({
      ...t,
      direct: (p, ...a) => (p.endsWith('bad') ? Promise.reject(new FsError('forbidden')) : t.direct(p, ...a)),
    }));
    const r = await uploader.upload(['a', 'b', 'bad', 'c', 'd'].map((n) => item(n, 'x')), '');
    expect(r.uploaded).toHaveLength(4);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.path).toBe('bad');
    expect(await has(fs, 'bad')).toBe(false);
    expect(r.cancelled).toBe(false);
  });

  it('invalid or escaping relative paths fail without uploading; the run continues', async () => {
    const { fs, uploader } = setup({ 'secret.txt': 's' });
    const bad = ['../evil.txt', 'a/../../evil.txt', 'a/./b', '/abs.txt', 'a//b', 'con.txt', 'trail.', 'x\\y', ''];
    const r = await uploader.upload([...bad.map((p) => item(p, 'x')), item('ok/fine.txt', 'x')], 'sub');
    expect(r.failed.map((f) => f.path)).toEqual(bad);
    expect(r.failed.every((f) => isFsError(f.error) && f.error.kind === 'invalid')).toBe(true);
    expect(r.uploaded.map((e) => e.path)).toEqual(['sub/ok/fine.txt']);
    expect(await has(fs, 'evil.txt')).toBe(false);
    expect((await fs.list!('', { depth: 9 })).map((e) => e.path).sort()).toEqual(['secret.txt', 'sub', 'sub/ok', 'sub/ok/fine.txt']);
  });
});

describe('conflicts', () => {
  const files = { 'd/x.txt': 'old', 'd/x copy.txt': 'old copy' };
  it('keepBoth (the default) uploads to a free "copy" name', async () => {
    const { fs, uploader } = setup(files);
    const r = await uploader.upload([item('x.txt', 'new')], 'd');
    expect(r.uploaded.map((e) => e.path)).toEqual(['d/x copy 2.txt']);
    expect(await text(fs, 'd/x.txt')).toBe('old');
    expect(await text(fs, 'd/x copy 2.txt')).toBe('new');
  });
  it('skip leaves the original and records the path', async () => {
    const { fs, uploader } = setup(files);
    const r = await uploader.upload([item('x.txt', 'new')], 'd', { onConflict: 'skip' });
    expect(r.skipped).toEqual(['d/x.txt']);
    expect(r.uploaded).toEqual([]);
    expect(await text(fs, 'd/x.txt')).toBe('old');
  });
  it('replace overwrites, for direct and chunked uploads', async () => {
    const { fs, uploader } = setup({ ...files, 'd/big.txt': 'old' });
    await uploader.upload([item('x.txt', 'new'), item('big.txt', '123456789')], 'd', { onConflict: 'replace' });
    expect(await text(fs, 'd/x.txt')).toBe('new');
    expect(await text(fs, 'd/big.txt')).toBe('123456789');
  });
  it('an unknown conflict answer fails the item and leaves the original alone', async () => {
    const { fs, uploader } = setup(files);
    const r = await uploader.upload([item('x.txt', 'new')], 'd', {
      onConflict: (async () => undefined) as unknown as () => Promise<'skip'>,
    });
    expect(r.failed.map((f) => f.error.kind)).toEqual(['invalid']);
    expect(await text(fs, 'd/x.txt')).toBe('old');
  });
  it('accepts an async chooser called with the conflicting path', async () => {
    const { uploader } = setup(files);
    const asked: string[] = [];
    const r = await uploader.upload([item('x.txt', 'n')], 'd', { onConflict: async (p) => (asked.push(p), 'skip') });
    expect(asked).toEqual(['d/x.txt']);
    expect(r.skipped).toEqual(['d/x.txt']);
  });
});

describe('server-controlled bounds', () => {
  const badInit = (chunkSize: number, size = 40) => {
    let puts = 0;
    const aborted: string[] = [];
    const { uploader } = setup({}, (t) => ({
      ...t,
      chunked: {
        ...t.chunked!,
        init: async () => ({ uploadId: 'u', chunkSize }),
        put: async () => void puts++,
        abort: async (id) => void aborted.push(id),
      },
    }));
    return { uploader, size, puts: () => puts, aborted };
  };
  it.each([0, -1, 1.5, NaN])('rejects a non-integer or non-positive chunkSize from init (%s)', async (cs) => {
    const t = badInit(cs);
    const r = await t.uploader.upload([item('f', 'x'.repeat(t.size))], '');
    expect(r.failed.map((f) => f.error.kind)).toEqual(['invalid']);
    expect(t.aborted).toEqual(['u']);
    expect(t.puts()).toBe(0);
  });
  it('rejects a chunk count above 100_000', async () => {
    const t = badInit(1);
    const r = await t.uploader.upload([item('f', 'x'.repeat(100_001))], '');
    expect(r.failed.map((f) => f.error.kind)).toEqual(['invalid']);
    expect(t.aborted).toEqual(['u']);
    expect(t.puts()).toBe(0);
  });
  it('keepBoth gives up after 1000 taken candidates', async () => {
    let calls = 0;
    const u = createUploader({
      transport: setup().fs.upload!,
      exists: async () => (calls++, true),
      remove: async () => {},
    });
    const r = await u.upload([item('x.txt', 'x')], '');
    expect(r.failed.map((f) => f.error.kind)).toEqual(['conflict']);
    expect(calls).toBe(1001);
  });
  it('keepBoth name search stops on cancel', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const u = createUploader({
      transport: setup().fs.upload!,
      exists: async () => {
        if (++calls === 3) ctl.abort();
        return true;
      },
      remove: async () => {},
    });
    const r = await u.upload([item('x.txt', 'x')], '', { signal: ctl.signal });
    expect(r.cancelled).toBe(true);
    expect(calls).toBe(3);
  });
});

describe('cancel', () => {
  it('keeps pre-existing paths, removes only what this run created', async () => {
    const puts = gate();
    const ctl = new AbortController();
    const { fs, uploader } = setup({ 'a.txt': 'old' }, (t) => ({
      ...t,
      chunked: {
        ...t.chunked!,
        put: async (...a) => {
          await puts.hold();
          return t.chunked!.put(...a);
        },
      },
    }));
    const p = uploader.upload([item('a.txt', 'replaced-long'), item('new.txt', 'x'.repeat(40))], '', {
      onConflict: 'replace',
      signal: ctl.signal,
    });
    while (puts.held.length === 0) await flush();
    ctl.abort();
    const r = await drive(p, puts);
    expect(r.cancelled).toBe(true);
    expect(await text(fs, 'a.txt')).toBe('old');
    expect(await has(fs, 'new.txt')).toBe(false);
    expect(r.uploaded.map((e) => e.path)).not.toContain('new.txt');
  });

  it('aborts the chunked session of a cancelled upload', async () => {
    const puts = gate();
    const ctl = new AbortController();
    const aborted: string[] = [];
    const { uploader } = setup({}, (t) => ({
      ...t,
      chunked: {
        ...t.chunked!,
        put: async (...a) => (await puts.hold(), t.chunked!.put(...a)),
        abort: async (id) => (aborted.push(id), t.chunked!.abort(id)),
      },
    }));
    const p = uploader.upload([item('f', 'x'.repeat(40))], '', { signal: ctl.signal });
    while (puts.held.length === 0) await flush();
    ctl.abort();
    await drive(p, puts);
    expect(aborted).toHaveLength(1);
  });

  it('cancel during chunked init sends no chunks and aborts the session', async () => {
    const init = gate();
    const ctl = new AbortController();
    let puts = 0;
    const aborted: string[] = [];
    const { uploader } = setup({}, (t) => ({
      ...t,
      chunked: {
        ...t.chunked!,
        init: async (...a) => (await init.hold(), t.chunked!.init(...a)),
        put: (...a) => (puts++, t.chunked!.put(...a)),
        abort: async (id) => (aborted.push(id), t.chunked!.abort(id)),
      },
    }));
    const p = uploader.upload([item('f', 'x'.repeat(40))], '', { signal: ctl.signal });
    while (init.held.length === 0) await flush();
    ctl.abort();
    const r = await drive(p, init);
    expect(puts).toBe(0);
    expect(aborted).toHaveLength(1);
    expect(r.cancelled).toBe(true);
  });

  it('never deletes a file another writer created after the exists check', async () => {
    const puts = gate();
    const ctl = new AbortController();
    const { fs, uploader } = setup({}, (t) => ({
      direct: async (p, f, o) => {
        if (p !== 'a') return t.direct(p, f, o);
        await fs.write!('a', 'other'); // lost the race
        throw new FsError('conflict');
      },
      chunked: { ...t.chunked!, put: async (...a) => (await puts.hold(), t.chunked!.put(...a)) },
    }));
    const p = uploader.upload([item('a', 'x'), item('b', 'x'.repeat(40))], '', { signal: ctl.signal });
    while (puts.held.length === 0) await flush();
    await flush();
    ctl.abort();
    const r = await drive(p, puts);
    expect(r.cancelled).toBe(true);
    expect(r.failed.map((f) => f.error.kind)).toEqual(['conflict']);
    expect(await text(fs, 'a')).toBe('other');
    expect(await has(fs, 'b')).toBe(false);
  });

  it('a failed chunked upload also aborts its session', async () => {
    const aborted: string[] = [];
    const { fs, uploader } = setup({}, (t) => ({
      ...t,
      chunked: {
        ...t.chunked!,
        put: () => Promise.reject(new FsError('forbidden')),
        abort: async (id) => (aborted.push(id), t.chunked!.abort(id)),
      },
    }));
    const r = await uploader.upload([item('f', 'x'.repeat(40))], '');
    expect(r.failed.map((f) => f.error.kind)).toEqual(['forbidden']);
    expect(aborted).toHaveLength(1);
    expect(await has(fs, 'f')).toBe(false);
  });

  it('waits for in-flight requests before cleanup, so a late write cannot resurrect a file', async () => {
    const late = gate();
    const ctl = new AbortController();
    let reached: Promise<void> = Promise.resolve();
    const { fs, uploader } = setup({}, (t) => ({
      ...t,
      // Ignores the abort signal, like a request that is already on the wire.
      direct: async (p, f, o) => {
        reached = late.hold();
        await reached;
        return t.direct(p, f, { ...o, signal: new AbortController().signal });
      },
    }));
    let settled = false;
    const p = uploader.upload([item('late.txt', 'x')], '', { signal: ctl.signal }).finally(() => (settled = true));
    while (late.held.length === 0) await flush();
    ctl.abort();
    await flush();
    await flush();
    expect(settled).toBe(false);
    late.release();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(await has(fs, 'late.txt')).toBe(false);
  });
});

describe('progress', () => {
  it('is monotonic and ends at totalBytes with every file done', async () => {
    const { uploader } = setup();
    const seen: UploadProgress[] = [];
    const items = [item('a', 'x'.repeat(40)), item('b', 'yy'), item('c', 'z'.repeat(9))];
    const r = await uploader.upload(items, 'd', { onProgress: (p) => seen.push({ ...p }) });
    expect(r.uploaded).toHaveLength(3);
    const loads = seen.map((p) => p.loadedBytes);
    expect(loads).toEqual([...loads].sort((a, b) => a - b));
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ loadedBytes: 51, totalBytes: 51, done: 3, total: 3 });
    expect(seen.every((p) => p.totalBytes === 51)).toBe(true);
  });
});

