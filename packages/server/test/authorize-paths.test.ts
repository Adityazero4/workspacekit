import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, type EntriesResponse } from '@workspacekit/core';
import { createFileHandler, nodeFsStore, type FileHandlerOptions, type FileStore } from '../src';

const H = { [CSRF_HEADER]: '1' };

let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'authorize-paths-')));
  root = path.join(base, 'root');
  await mkdir(path.join(root, 'private'), { recursive: true });
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'private/secret.txt'), 'TOP-SECRET');
  await writeFile(path.join(root, 'public/readme.txt'), 'hi');
  await symlink('../private/secret.txt', path.join(root, 'public/link.txt'));
  await symlink('../private', path.join(root, 'public/dir'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const url = (route: string, query: Record<string, string> = {}): string =>
  `http://t/api/files/${route}?${new URLSearchParams(query).toString()}`;
const post = (route: string, body: unknown): Request =>
  new Request(url(route), { method: 'POST', headers: H, body: JSON.stringify(body) });

function publicOnly(): { handler: (request: Request) => Promise<Response>; seen: string[] } {
  const seen: string[] = [];
  const handler = createFileHandler({
    store: nodeFsStore(root),
    authorize: (_request, op, requested) => {
      seen.push(`${op}:${requested}`);
      return requested === '' || requested === 'public' || requested.startsWith('public/');
    },
  });
  return { handler, seen };
}

describe('a symlink inside the root is authorized as its own path and as its target', () => {
  it('read, stat and write through a file link ask for the target and are denied', async () => {
    const { handler, seen } = publicOnly();
    expect((await handler(new Request(url('read', { path: 'public/link.txt' })))).status).toBe(403);
    expect((await handler(new Request(url('stat', { path: 'public/link.txt' })))).status).toBe(403);
    const write = new Request(url('write', { path: 'public/link.txt' }), {
      method: 'PUT',
      headers: H,
      body: 'OVERWRITTEN',
    });
    expect((await handler(write)).status).toBe(403);
    expect(await readFile(path.join(root, 'private/secret.txt'), 'utf8')).toBe('TOP-SECRET');
    expect(seen).toContain('read:private/secret.txt');
    expect(seen).toContain('write:private/secret.txt');
  });

  it('list and download of a linked folder ask for the folder it points to', async () => {
    const { handler, seen } = publicOnly();
    expect((await handler(new Request(url('list', { path: 'public/dir' })))).status).toBe(403);
    expect((await handler(post('download', { paths: ['public/dir'] }))).status).toBe(403);
    expect(seen).toEqual(['list:public/dir', 'list:private', 'download:public/dir', 'download:private']);
  });

  it('a file reached through a linked folder is checked by its real path', async () => {
    const { handler } = publicOnly();
    const read = new Request(url('read', { path: 'public/dir/secret.txt' }));
    expect((await handler(read)).status).toBe(403);
    const copy = await handler(post('copy', { from: 'public/dir/secret.txt', to: 'public/copy.txt' }));
    expect(copy.status).toBe(403);
    const move = await handler(post('move', { from: 'public/readme.txt', to: 'public/dir/readme.txt' }));
    expect(move.status).toBe(403);
    expect(await readFile(path.join(root, 'public/readme.txt'), 'utf8')).toBe('hi');
  });

  it('a folder download leaves out a linked file whose target is denied', async () => {
    const { handler, seen } = publicOnly();
    const response = await handler(post('download', { paths: ['public'] }));
    expect(response.status).toBe(200);
    const names = Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer()))).sort();
    expect(names).toEqual(['public/', 'public/readme.txt']);
    expect(seen).toContain('download:private/secret.txt');
  });

  it('paths without links are asked once', async () => {
    const { handler, seen } = publicOnly();
    const listing = await handler(new Request(url('list', { path: 'public' })));
    expect(listing.status).toBe(200);
    expect(((await listing.json()) as EntriesResponse).entries.length).toBe(3);
    expect((await handler(post('create', { path: 'public/new/a.txt', kind: 'file' }))).status).toBe(200);
    expect(seen).toEqual(['list:public', 'create:public/new/a.txt']);
  });
});

describe('a link swapped in after authorization', () => {
  const isPublic = (requested: string): boolean =>
    requested === '' || requested === 'public' || requested.startsWith('public/');

  it('a zip entry is authorized again when it is opened, so a later swap cannot reach a private file', async () => {
    await writeFile(path.join(root, 'public/aa.bin'), 'A'.repeat(4 * 1024 * 1024));
    await writeFile(path.join(root, 'public/zz.txt'), 'harmless');
    await mkdir(path.join(root, 'public/sub'));
    await symlink('../private/secret.txt', path.join(root, 'public/sub/k'));
    await mkdir(path.join(root, 'public/private'));
    await writeFile(path.join(root, 'public/private/secret.txt'), 'decoy');
    const handler = createFileHandler({ store: nodeFsStore(root), authorize: (_r, _op, p) => isPublic(p) });
    const response = await handler(post('download', { paths: ['public/aa.bin', 'public/zz.txt'] }));
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [(await reader.read()).value!];
    const remove = new Request(url('delete', { path: 'public/zz.txt' }), { method: 'DELETE', headers: H });
    expect((await handler(remove)).status).toBe(204);
    expect((await handler(post('copy', { from: 'public/sub/k', to: 'public/zz.txt' }))).status).toBe(200);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) chunks.push(chunk.value);
    expect(Buffer.concat(chunks).toString('latin1')).not.toContain('TOP-SECRET');
  });

  it('a read opens only the real path that was authorized', async () => {
    const real = nodeFsStore(root);
    const racing: FileStore = {
      ...real,
      canonicalPath: async (requested) => {
        const checked = await real.canonicalPath!(requested);
        await rm(path.join(root, 'public/readme.txt'));
        await symlink('../private/secret.txt', path.join(root, 'public/readme.txt'));
        return checked;
      },
    };
    const handler = createFileHandler({ store: racing, authorize: (_r, _op, p) => isPublic(p) });
    const response = await handler(new Request(url('read', { path: 'public/readme.txt' })));
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('TOP-SECRET');
  });

  it('nodeFsStore.read refuses a path that no longer resolves to the authorized one', async () => {
    const read = nodeFsStore(root).read('public/link.txt', undefined, {
      expectedCanonicalPath: 'public/link.txt',
    });
    await expect(read).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('only true allows', () => {
  it.each([['no'], [{}], [{ ok: false }], [1], ['true']])(
    'authorize returning %j is a 403',
    async (result) => {
      const handler = createFileHandler({
        store: nodeFsStore(root),
        authorize: (() => result) as unknown as FileHandlerOptions['authorize'],
      });
      const response = await handler(new Request(url('read', { path: 'public/readme.txt' })));
      expect(response.status).toBe(403);
    },
  );
});
