import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CSRF_HEADER,
  type ChangeEvent,
  type EntriesResponse,
  type UploadInitResponse,
} from '@workspacekit/core';
import { createFileHandler, nodeFsStore, type FileHandlerOptions, type FileStore } from '../src';

const H = { [CSRF_HEADER]: '1' };

let base: string;
let root: string;
let uploadTempDir: string;
let previousTmpDir: string | undefined;
let store: FileStore;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'limits-')));
  root = path.join(base, 'root');
  uploadTempDir = path.join(base, 'tmp');
  await mkdir(root);
  await mkdir(uploadTempDir);
  previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = uploadTempDir;
  store = nodeFsStore(root);
});
afterEach(async () => {
  vi.useRealTimers();
  if (previousTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpDir;
  await rm(base, { recursive: true, force: true });
});

type Handler = (request: Request) => Promise<Response>;

const make = (options: Partial<FileHandlerOptions> = {}): Handler =>
  createFileHandler({ store, authorize: () => true, ...options });
const url = (route: string, query: Record<string, string | number> = {}): string =>
  `http://t/api/files/${route}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}`;
const post = (route: string, body: unknown): Request =>
  new Request(url(route), { method: 'POST', headers: H, body: JSON.stringify(body) });
const chunk = (id: string, index: number, offset: number, data: string): Request =>
  new Request(url('upload/chunk', { id, index, offset }), { method: 'PUT', headers: H, body: data });
const abort = (id: string): Request => new Request(url('upload', { id }), { method: 'DELETE', headers: H });
const startUpload = (handler: Handler, target: string, totalBytes: number): Promise<Response> =>
  handler(post('upload/init', { path: target, totalBytes }));

async function uploadId(response: Promise<Response>): Promise<string> {
  const settled = await response;
  expect(settled.status).toBe(200);
  return ((await settled.json()) as UploadInitResponse).uploadId;
}

async function sessionFolders(): Promise<string[]> {
  const found: string[] = [];
  for (const folder of await readdir(uploadTempDir)) {
    for (const session of await readdir(path.join(uploadTempDir, folder))) found.push(`${folder}/${session}`);
  }
  return found;
}

describe('upload temp storage', () => {
  it('caps the number of unfinished uploads, with 503 and Retry-After past it', async () => {
    const handler = make({ maxUploadSessions: 2 });
    const first = await uploadId(startUpload(handler, 'a.bin', 1));
    await uploadId(startUpload(handler, 'b.bin', 1));
    const refused = await startUpload(handler, 'c.bin', 1);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect((await handler(abort(first))).status).toBe(204);
    await uploadId(startUpload(handler, 'c.bin', 1));
  });

  it('caps the bytes that unfinished uploads may reserve', async () => {
    const handler = make({ maxUploadTempBytes: 10 });
    await uploadId(startUpload(handler, 'a.bin', 6));
    expect((await startUpload(handler, 'b.bin', 5)).status).toBe(503);
    await uploadId(startUpload(handler, 'b.bin', 4));
  });

  it('sweeps an abandoned upload on a timer, with no further request', async () => {
    const handler = make({ chunkSize: 4, uploadTtlMs: 40 });
    const id = await uploadId(startUpload(handler, 'a.bin', 8));
    expect((await handler(chunk(id, 0, 0, 'abcd'))).status).toBe(204);
    expect(await sessionFolders()).toHaveLength(1);
    await vi.waitFor(async () => expect(await sessionFolders()).toEqual([]));
  });

  it('a denied request does not keep a session alive', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    let deny = false;
    const handler = make({ chunkSize: 4, uploadTtlMs: 1000, authorize: () => !deny });
    const id = await uploadId(startUpload(handler, 'a.bin', 4));
    await vi.advanceTimersByTimeAsync(900);
    deny = true;
    expect((await handler(chunk(id, 0, 0, 'abcd'))).status).toBe(403);
    deny = false;
    await vi.advanceTimersByTimeAsync(400);
    expect((await handler(abort(id))).status).toBe(404);
  });

  it('gives each handler its own private temp folder by default', async () => {
    await uploadId(startUpload(make(), 'a.bin', 1));
    await uploadId(startUpload(make(), 'b.bin', 1));
    const folders = await readdir(uploadTempDir);
    expect(folders).toHaveLength(2);
    for (const folder of folders) {
      expect(folder).toMatch(/^workspacekit-uploads-/);
      expect((await stat(path.join(uploadTempDir, folder))).mode & 0o777).toBe(0o700);
    }
  });
});

describe('upload temp bytes actually written', () => {
  const encoder = new TextEncoder();
  function heldChunk(handler: Handler, id: string, index: number, offset: number, data: string) {
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(data));
        finish = () => controller.close();
      },
    });
    const init = { method: 'PUT', headers: H, body, duplex: 'half' } as RequestInit;
    const response = handler(new Request(url('upload/chunk', { id, index, offset }), init));
    return { response, finish: () => finish() };
  }
  async function partFileBytes(): Promise<number[]> {
    const sizes: number[] = [];
    for (const folder of await sessionFolders()) {
      for (const name of await readdir(path.join(uploadTempDir, folder))) {
        if (name.endsWith('.part')) sizes.push((await stat(path.join(uploadTempDir, folder, name))).size);
      }
    }
    return sizes;
  }

  it('refuses a chunk whose bytes would pass maxUploadTempBytes, re-sent chunks included', async () => {
    const handler = make({ chunkSize: 4, maxUploadTempBytes: 8 });
    const id = await uploadId(startUpload(handler, 'a.bin', 8));
    expect((await handler(chunk(id, 0, 0, 'abcd'))).status).toBe(204);
    expect((await handler(chunk(id, 1, 4, 'efgh'))).status).toBe(204);
    expect((await handler(chunk(id, 0, 0, 'abcd'))).status).toBe(413);
    expect((await handler(post('upload/complete', { uploadId: id }))).status).toBe(200);
  });

  it('a session never holds more than its total plus one chunk', async () => {
    const handler = make({ chunkSize: 4 });
    const id = await uploadId(startUpload(handler, 'a.bin', 8));
    expect((await handler(chunk(id, 0, 0, 'abcd'))).status).toBe(204);
    expect((await handler(chunk(id, 1, 4, 'efgh'))).status).toBe(204);
    const resent = heldChunk(handler, id, 0, 0, 'abcd');
    await vi.waitFor(async () => expect(await partFileBytes()).toEqual([4]));
    expect((await handler(chunk(id, 1, 4, 'efgh'))).status).toBe(413);
    resent.finish();
    expect((await resent.response).status).toBe(204);
  });

  it('refuses a second in-flight PUT of the same chunk, and more than 8 chunks of one upload at once', async () => {
    const handler = make({ chunkSize: 1 });
    const id = await uploadId(startUpload(handler, 'a.bin', 10));
    const held = Array.from({ length: 8 }, (_, index) => heldChunk(handler, id, index, index, 'x'));
    await vi.waitFor(async () => expect(await partFileBytes()).toHaveLength(8));
    expect((await handler(chunk(id, 0, 0, 'x'))).status).toBe(409);
    expect((await handler(chunk(id, 8, 8, 'x'))).status).toBe(409);
    for (const pending of held) pending.finish();
    for (const pending of held) expect((await pending.response).status).toBe(204);
    expect((await handler(chunk(id, 8, 8, 'x'))).status).toBe(204);
  });
});

describe('uploadTempDir', () => {
  const sessionName = '0b4e7c1e-8d3a-4b5f-9c2d-1e2f3a4b5c6d';
  let ownFolder: string;
  beforeEach(async () => {
    ownFolder = path.join(base, 'uploads');
    await mkdir(ownFolder, { mode: 0o700 });
    await chmod(ownFolder, 0o700);
  });

  it('keeps sessions in a marked subfolder it made, and sweeps only stale sessions there', async () => {
    const longAgo = new Date(Date.now() - 120_000);
    const integratorData = path.join(ownFolder, sessionName);
    await mkdir(integratorData);
    await writeFile(path.join(integratorData, 'user-data.json'), '{}');
    await utimes(integratorData, longAgo, longAgo);
    const first = make({ uploadTempDir: ownFolder, uploadTtlMs: 60_000 });
    const id = await uploadId(startUpload(first, 'a.bin', 1));
    const sessions = path.join(ownFolder, 'workspacekit-uploads');
    expect(await readdir(sessions)).toEqual(expect.arrayContaining(['.workspacekit-uploads', id]));
    expect((await first(abort(id))).status).toBe(204);
    const staleName = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const freshName = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
    for (const name of [staleName, freshName]) await mkdir(path.join(sessions, name));
    await utimes(path.join(sessions, staleName), longAgo, longAgo);
    await uploadId(startUpload(make({ uploadTempDir: ownFolder, uploadTtlMs: 60_000 }), 'b.bin', 1));
    const left = await readdir(sessions);
    expect(left).not.toContain(staleName);
    expect(left).toContain(freshName);
    expect(await readdir(integratorData)).toEqual(['user-data.json']);
  });

  it('refuses a sessions subfolder that has content but no marker', async () => {
    const onError = vi.fn();
    const sessions = path.join(ownFolder, 'workspacekit-uploads');
    await mkdir(sessions, { mode: 0o700 });
    await chmod(sessions, 0o700);
    await writeFile(path.join(sessions, 'notes.txt'), 'keep me');
    expect((await startUpload(make({ uploadTempDir: ownFolder, onError }), 'a.bin', 1)).status).toBe(500);
    expect(String(onError.mock.calls[0]![0])).toMatch(/no \.workspacekit-uploads marker/);
    expect(await readdir(sessions)).toEqual(['notes.txt']);
  });

  it('refuses a folder that is not private to this user, or a link to one', async () => {
    const onError = vi.fn();
    await chmod(ownFolder, 0o755);
    expect((await startUpload(make({ uploadTempDir: ownFolder, onError }), 'a.bin', 1)).status).toBe(500);
    await chmod(ownFolder, 0o700);
    await symlink(ownFolder, path.join(base, 'link'));
    const throughLink = make({ uploadTempDir: path.join(base, 'link'), onError });
    expect((await startUpload(throughLink, 'a.bin', 1)).status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(String(onError.mock.calls[0]![0])).toMatch(/uploadTempDir.*docs\/server\/handler#uploadtempdir/);
  });

  it('refuses a second live handler on the same folder in one process', async () => {
    const first = make({ uploadTempDir: ownFolder });
    const second = make({ uploadTempDir: ownFolder });
    const id = await uploadId(startUpload(first, 'a.bin', 1));
    expect((await startUpload(second, 'b.bin', 1)).status).toBe(500);
    expect((await first(abort(id))).status).toBe(204);
    await uploadId(startUpload(second, 'b.bin', 1));
  });
});

describe('upload fairness between principals', () => {
  const asActor = (actor: string, request: Request): Request => {
    request.headers.set('X-Actor', actor);
    return request;
  };
  const byHeader = (request: Request): string => request.headers.get('X-Actor') ?? 'anonymous';

  it('caps each actor at a quarter of maxUploadSessions, evicting their oldest idle session first', async () => {
    const handler = make({ maxUploadSessions: 8, actor: byHeader });
    const start = (actor: string, target: string): Promise<Response> =>
      handler(asActor(actor, post('upload/init', { path: target, totalBytes: 1 })));
    const oldest = await uploadId(start('alice', 'a.bin'));
    await uploadId(start('alice', 'b.bin'));
    await uploadId(start('alice', 'c.bin'));
    expect((await handler(chunk(oldest, 0, 0, 'x'))).status).toBe(404);
    await uploadId(start('bob', 'd.bin'));
    await uploadId(start('bob', 'e.bin'));
  });

  it('caps the bytes one actor may reserve at a quarter of maxUploadTempBytes', async () => {
    const handler = make({ maxUploadTempBytes: 100, actor: byHeader });
    const start = (actor: string, target: string, totalBytes: number): Promise<Response> =>
      handler(asActor(actor, post('upload/init', { path: target, totalBytes })));
    await uploadId(start('alice', 'a.bin', 20));
    const refused = await start('alice', 'b.bin', 30);
    expect(refused.status).toBe(503);
    await uploadId(start('bob', 'c.bin', 25));
  });

  it('refuses an actor whose sessions are all busy', async () => {
    const handler = make({ maxUploadSessions: 4, actor: byHeader });
    const start = (target: string): Promise<Response> =>
      handler(asActor('alice', post('upload/init', { path: target, totalBytes: 1 })));
    const id = await uploadId(start('a.bin'));
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => void (finish = () => controller.close()),
    });
    const init = { method: 'PUT', headers: H, body, duplex: 'half' } as RequestInit;
    const busy = handler(new Request(url('upload/chunk', { id, index: 0, offset: 0 }), init));
    await vi.waitFor(async () => expect((await sessionFolders()).length).toBe(1));
    await vi.waitFor(async () => {
      const [folder] = await sessionFolders();
      expect((await readdir(path.join(uploadTempDir, folder!))).length).toBe(1);
    });
    expect((await start('b.bin')).status).toBe(503);
    finish();
    expect((await busy).status).toBe(400);
  });
});

describe('watch connections', () => {
  const watchRequest = (signal?: AbortSignal): Request =>
    new Request(url('watch'), signal === undefined ? {} : { signal });

  it('caps open watch connections, with 503 and Retry-After past it', async () => {
    const handler = make({ store: { ...store, watch: () => () => undefined }, maxWatchConnections: 1 });
    const first = new AbortController();
    expect((await handler(watchRequest(first.signal))).status).toBe(200);
    const refused = await handler(watchRequest());
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    first.abort();
    const reopened = await handler(watchRequest());
    expect(reopened.status).toBe(200);
    await reopened.body?.cancel();
  });

  it('closes a connection whose unread buffer passes watchBufferBytes, so the client reconnects', async () => {
    let emit: (events: ChangeEvent[]) => void = () => undefined;
    let unsubscribed = false;
    const watching: FileStore = {
      ...store,
      watch: (onChange) => ((emit = onChange), () => void (unsubscribed = true)),
    };
    const response = await make({ store: watching, watchBufferBytes: 1024 })(watchRequest());
    const batch = Array.from({ length: 100 }, (_, at): ChangeEvent => ({
      type: 'updated',
      path: `f${at}.txt`,
    }));
    emit(batch);
    emit(batch);
    expect(unsubscribed).toBe(true);
    await expect(response.text()).rejects.toThrow(/fell too far behind/);
  });

  it('discards what a cut-off stream had queued, so non-reading clients cannot pile up buffers', async () => {
    const listeners = new Set<(events: ChangeEvent[]) => void>();
    const watching: FileStore = {
      ...store,
      watch: (onChange) => (listeners.add(onChange), () => void listeners.delete(onChange)),
    };
    const handler = make({ store: watching, maxWatchConnections: 2, watchBufferBytes: 1024 });
    const batch = Array.from({ length: 100 }, (_, at): ChangeEvent => ({
      type: 'updated',
      path: `f${at}.txt`,
    }));
    const neverRead: Response[] = [];
    for (let round = 0; round < 10; round++) {
      for (let client = 0; client < 2; client++) neverRead.push(await handler(watchRequest()));
      for (const listener of [...listeners]) listener(batch);
      for (const listener of [...listeners]) listener(batch);
    }
    expect(neverRead.map((response) => response.status)).toEqual(Array(20).fill(200));
    let bufferedBytes = 0;
    for (const response of neverRead) {
      const reader = response.body!.getReader();
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          bufferedBytes += chunk.value.byteLength;
        }
      } catch {
        continue;
      }
    }
    expect(bufferedBytes).toBe(0);
  });
});

describe('watch connection lifecycle', () => {
  const watchRequest = (signal?: AbortSignal, actor = 'alice'): Request =>
    new Request(url('watch'), { headers: { 'X-Actor': actor }, ...(signal === undefined ? {} : { signal }) });
  const byHeader = (request: Request): string => request.headers.get('X-Actor') ?? 'anonymous';

  it('frees the slot even when unsubscribing throws', async () => {
    const onError = vi.fn();
    const throwing: FileStore = {
      ...store,
      watch: () => () => {
        throw new Error('unsubscribe failed');
      },
    };
    const handler = make({ store: throwing, maxWatchConnections: 1, onError });
    const first = new AbortController();
    expect((await handler(watchRequest(first.signal))).status).toBe(200);
    first.abort();
    const reopened = await handler(watchRequest());
    expect(reopened.status).toBe(200);
    await reopened.body?.cancel();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'unsubscribe failed' }),
      expect.any(Request),
    );
  });

  it('caps each actor at a quarter of maxWatchConnections when actor is set', async () => {
    const handler = make({
      store: { ...store, watch: () => () => undefined },
      maxWatchConnections: 8,
      actor: byHeader,
    });
    const open: Response[] = [];
    for (let at = 0; at < 2; at++) open.push(await handler(watchRequest(undefined, 'alice')));
    expect(open.map((response) => response.status)).toEqual([200, 200]);
    expect((await handler(watchRequest(undefined, 'alice'))).status).toBe(503);
    const bob = await handler(watchRequest(undefined, 'bob'));
    expect(bob.status).toBe(200);
    for (const response of [...open, bob]) await response.body?.cancel();
    const again = await handler(watchRequest(undefined, 'alice'));
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });

  it('closes a stream after watchMaxLifetimeMs, so the client reconnects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let unsubscribed = false;
    const watching: FileStore = { ...store, watch: () => () => void (unsubscribed = true) };
    const response = await make({ store: watching, watchMaxLifetimeMs: 1000 })(watchRequest());
    await vi.advanceTimersByTimeAsync(999);
    expect(unsubscribed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(unsubscribed).toBe(true);
    expect(await response.text()).toBe(': ping\n\n');
  });
});

describe('walks', () => {
  beforeEach(async () => {
    for (const name of ['a/b/c/deep-match.txt', 'top-match.txt', 'x1.txt', 'x2.txt', 'x3.txt']) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), name);
    }
  });
  const aborted = (): AbortSignal => AbortSignal.abort();
  const found = async (response: Response): Promise<string[]> =>
    ((await response.json()) as EntriesResponse).entries.map((entry) => entry.path);

  it('refuses a list deeper than maxListDepth (default 16)', async () => {
    expect((await make()(new Request(url('list', { depth: 17 })))).status).toBe(400);
    expect((await make()(new Request(url('list', { depth: 16 })))).status).toBe(200);
    const shallow = make({ maxListDepth: 2 });
    expect((await shallow(new Request(url('list', { depth: 3 })))).status).toBe(400);
    expect((await shallow(new Request(url('list', { depth: 2 })))).status).toBe(200);
  });

  it('refuses a listing of more than maxListEntries with 413, and the store stops walking past it', async () => {
    const response = await make({ maxListEntries: 7 })(new Request(url('list', { depth: 9 })));
    expect(response.status).toBe(413);
    expect((await make({ maxListEntries: 8 })(new Request(url('list', { depth: 9 })))).status).toBe(200);
    expect(await store.list('', Infinity, { maxEntries: 2 })).toHaveLength(3);
  });

  it('search stops after maxSearchVisits entries or searchTimeoutMs, answering what it found so far', async () => {
    const search = (options: Partial<FileHandlerOptions>): Promise<Response> =>
      make(options)(new Request(url('search', { q: 'match' })));
    expect(await found(await search({}))).toEqual(['top-match.txt', 'a/b/c/deep-match.txt']);
    expect(await found(await search({ maxSearchVisits: 5 }))).toEqual(['top-match.txt']);
    expect(await found(await search({ searchTimeoutMs: 0 }))).toEqual([]);
  });

  it('every walk stops when the request is aborted', async () => {
    expect((await store.search!('match', 10, { signal: aborted() })).length).toBe(0);
    await expect(store.list('', Infinity, { signal: aborted() })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    const onError = vi.fn();
    const handler = make({ onError });
    await handler(new Request(url('list', { depth: 9 }), { signal: aborted() }));
    const remove = new Request(url('delete', { path: 'a' }), {
      method: 'DELETE',
      headers: H,
      signal: aborted(),
    });
    await handler(remove);
    expect(await readdir(path.join(root, 'a'))).toEqual(['b']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a folder download asks the store to stop past the zip entry limit', async () => {
    const asked: unknown[] = [];
    const listing: FileStore = {
      ...store,
      list: (requested, depth, options) => (asked.push(options), store.list(requested, depth, options)),
    };
    const response = await make({ store: listing })(post('download', { paths: ['a'] }));
    expect(response.status).toBe(200);
    expect(asked).toEqual([{ signal: expect.any(AbortSignal), maxEntries: 65_535 }]);
  });
});

describe('one folder too big to read in one go', () => {
  const FILES = 2000;
  beforeEach(async () => {
    await mkdir(path.join(root, 'big'));
    for (let at = 0; at < FILES; at++) await writeFile(path.join(root, 'big', `f${at}.txt`), '');
  });

  it('reads no further than the cap, and lets other operations run while it reads', async () => {
    expect(await store.list('big', 1, { maxEntries: 5 })).toHaveLength(6);
    expect((await make({ maxListEntries: 5 })(new Request(url('list', { path: 'big' })))).status).toBe(413);
    const finished: string[] = [];
    const listing = store.list('big', 1).then((entries) => finished.push(`list of ${entries.length}`));
    const write = store.write('elsewhere.txt', new Uint8Array(1)).then(() => finished.push('write'));
    await Promise.all([listing, write]);
    expect(finished).toEqual(['write', `list of ${FILES}`]);
  });

  it('search stops inside the folder once its visit budget is spent', async () => {
    const found = await store.search!('f', 200, { maxVisits: 3 });
    expect(found.length).toBeLessThanOrEqual(3);
  });

  it.each([
    ['moved', (): Promise<unknown> => store.move('big', 'moved')],
    ['deleted', (): Promise<unknown> => store.delete('big')],
  ])('a listing whose folder is %s midway fails instead of answering part of it', async (_label, change) => {
    const listing = store.list('big', 1).then(
      (entries) => entries.length,
      (error: { kind?: string }) => error.kind,
    );
    await store.stat('big');
    await change();
    expect(await listing).toBe('not_found');
  });
});

describe('limit options', () => {
  it.each([
    'maxUploadSessions',
    'maxUploadTempBytes',
    'maxWatchConnections',
    'watchBufferBytes',
    'maxListDepth',
    'maxListEntries',
    'maxSearchVisits',
    'searchTimeoutMs',
    'maxUploadSessionsPerActor',
    'maxUploadTempBytesPerActor',
    'maxWatchConnectionsPerActor',
    'watchMaxLifetimeMs',
  ])('%s must be a non-negative integer or Infinity', (option) => {
    for (const bad of [-1, 1.5, Number.NaN, '10']) {
      expect(() => make({ [option]: bad })).toThrow(new RegExp(`${option}.*docs/server/handler#limits`));
    }
    expect(() => make({ [option]: Infinity })).not.toThrow();
  });
});
