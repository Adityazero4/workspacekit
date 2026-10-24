import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFsError, type FsErrorKind } from '@workspacekit/core';
import { nodeFsStore, type FileStore } from '../src';

let base: string;
let root: string;
let outside: string;
let store: FileStore;
const enc = new TextEncoder();

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'store-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 's');
  await symlink(outside, path.join(root, 'link'));
  store = nodeFsStore(root, { exclude: ['.git'] });
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function fail(p: Promise<unknown>): Promise<{ kind?: FsErrorKind; message: string }> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!isFsError(e)) throw new Error(`expected an FsError, got ${String(e)}`);
  return { kind: e.kind, message: e.message };
}
const kindOf = async (p: Promise<unknown>): Promise<FsErrorKind | undefined> => (await fail(p)).kind;
const disk = (p: string): Promise<string> => readFile(path.join(root, p), 'utf8');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stream = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
const slurp = async (s: ReadableStream<Uint8Array>): Promise<string> => new Response(s).text();

describe('symlink jail', () => {
  it('denies every operation through a link that leaves the root', async () => {
    expect(await kindOf(store.list('link', 1))).toBe('forbidden');
    expect(await kindOf(store.read('link/secret.txt'))).toBe('forbidden');
    expect(await kindOf(store.write('link/new.txt', enc.encode('x')))).toBe('forbidden');
    expect(await kindOf(store.write('link/a/b.txt', enc.encode('x')))).toBe('forbidden');
    expect(await kindOf(store.create('link/new.txt', 'file'))).toBe('forbidden');
    expect(await kindOf(store.move('link/secret.txt', 'moved.txt'))).toBe('forbidden');
    await store.write('mine.txt', enc.encode('m'));
    expect(await kindOf(store.move('mine.txt', 'link/mine.txt'))).toBe('forbidden');
    expect(await kindOf(store.copy('mine.txt', 'link/mine.txt'))).toBe('forbidden');
    expect(await kindOf(store.delete('link/secret.txt'))).toBe('forbidden');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('does not list escaping links and follows links inside the root', async () => {
    await store.write('real/f.txt', enc.encode('f'));
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    expect((await store.list('', 1)).map((e) => e.path).sort()).toEqual(['alias', 'real']);
    expect(await slurp((await store.read('alias/f.txt')).body)).toBe('f');
    await store.delete('alias'); // removes the link, not its target
    expect(await disk('real/f.txt')).toBe('f');
  });
});

describe('visibility', () => {
  it('exclude hides and denies', async () => {
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'c');
    await mkdir(path.join(root, 'sub', '.git'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'a.txt'), 'a');
    expect((await store.list('', 3)).map((e) => e.path).sort()).toEqual(['sub', 'sub/a.txt']);
    expect(await kindOf(store.read('.git/config'))).toBe('not_found');
    expect(await kindOf(store.write('.git/x', enc.encode('x')))).toBe('not_found');
    expect(await kindOf(store.delete('sub/.git'))).toBe('not_found');
    expect(await kindOf(store.move('sub/a.txt', '.git/a.txt'))).toBe('not_found');
    expect(await store.stat('.git')).toBeNull();
    expect(await store.search!('git', 10)).toEqual([]);
    expect(await store.search!('config', 10)).toEqual([]);
  });

  it("never lists this store's temp files", async () => {
    await writeFile(path.join(root, '.a.txt.0123456789ab.tmp'), 'x');
    await writeFile(path.join(root, '.keep.tmp'), 'user file');
    expect((await store.list('', 1)).map((e) => e.path)).toEqual(['.keep.tmp']);
  });

  it('refuses requests for names shaped like its temp files, so none can be stashed out of sight', async () => {
    await store.write('dir/innocent.txt', enc.encode('i'));
    expect(await kindOf(store.write('dir/.notes.0123456789ab.tmp', enc.encode('x')))).toBe('not_found');
    expect(await kindOf(store.create('dir/.notes.0123456789ab.tmp', 'file'))).toBe('not_found');
    await writeFile(path.join(root, 'dir', '.agent.0123456789ab.tmp'), 'stashed');
    expect(await kindOf(store.read('dir/.agent.0123456789ab.tmp'))).toBe('not_found');
    expect(await store.stat('dir/.agent.0123456789ab.tmp')).toBeNull();
  });

  it('leaves out names the API cannot address, such as ones with a backslash', async () => {
    await mkdir(path.join(root, 'out', '..\\..\\Startup'), { recursive: true });
    await writeFile(path.join(root, 'out', '..\\evil.bat'), 'x');
    await writeFile(path.join(root, 'out', 'ok.txt'), 'ok');
    expect((await store.list('out', 3)).map((e) => e.path)).toEqual(['out/ok.txt']);
    expect(await store.search!('evil', 10)).toEqual([]);
    expect(await store.search!('Startup', 10)).toEqual([]);
  });
});

describe('write', () => {
  it('creates files and parents, and replaces existing content', async () => {
    const e = await store.write('a/b/c.txt', enc.encode('one'));
    expect(e).toMatchObject({ path: 'a/b/c.txt', name: 'c.txt', kind: 'file', size: 3 });
    await store.write('a/b/c.txt', stream('t', 'wo'));
    expect(await disk('a/b/c.txt')).toBe('two');
    expect(await kindOf(store.write('a/b/c.txt', enc.encode('x'), { overwrite: false }))).toBe('conflict');
    expect(await kindOf(store.write('a/b', enc.encode('x')))).toBe('conflict');
    expect(await kindOf(store.write('a/b/c.txt/d', enc.encode('x')))).toBe('conflict');
  });

  it('expectedMtimeMs mismatch throws conflict and leaves file intact', async () => {
    const first = await store.write('w.txt', enc.encode('v1'));
    expect(Number.isInteger(first.mtimeMs)).toBe(true);
    await sleep(20);
    const second = await store.write('w.txt', enc.encode('v2'), { expectedMtimeMs: first.mtimeMs! });
    expect(second.mtimeMs!).toBeGreaterThan(first.mtimeMs!);
    expect((await store.stat('w.txt'))!.mtimeMs).toBe(second.mtimeMs);
    await sleep(20);
    expect(await kindOf(store.write('w.txt', enc.encode('v3'), { expectedMtimeMs: first.mtimeMs! }))).toBe(
      'conflict',
    );
    expect(await kindOf(store.write('gone.txt', enc.encode('v'), { expectedMtimeMs: 1 }))).toBe('conflict');
    expect(await disk('w.txt')).toBe('v2');
    expect(await readdir(root)).toEqual(['link', 'w.txt']);
  });

  it('is atomic: a failure mid-stream leaves the original and no temp file', async () => {
    await store.write('f.txt', enc.encode('original'));
    const big = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(enc.encode('1234'));
        await sleep(5);
      },
    });
    expect(await kindOf(store.write('f.txt', big, { maxBytes: 10 }))).toBe('too_large');
    expect(await kindOf(store.write('f.txt', enc.encode('0123456789ab'), { maxBytes: 10 }))).toBe(
      'too_large',
    );
    expect(await kindOf(store.write('new.txt', stream('12345678', '9012'), { maxBytes: 10 }))).toBe(
      'too_large',
    );
    expect(await disk('f.txt')).toBe('original');
    expect((await readdir(root)).sort()).toEqual(['f.txt', 'link']);
  });

  it('stages the write in the same directory under a hidden temp name', async () => {
    await store.write('d/f.txt', enc.encode('original'));
    let seen: string[] = [];
    const watcher = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(enc.encode('part'));
        await sleep(50); // let the staging file open
        seen = await readdir(path.join(root, 'd'));
        c.close();
      },
    });
    await store.write('d/f.txt', watcher);
    const staged = seen.filter((n) => n !== 'f.txt');
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatch(/^\.f\.txt\.[0-9a-f]+\.tmp$/);
    expect(await readdir(path.join(root, 'd'))).toEqual(['f.txt']);
  });
});

describe('read', () => {
  it('range returns exact bytes', async () => {
    await store.write('r.txt', enc.encode('0123456789'));
    const whole = await store.read('r.txt');
    expect(whole.size).toBe(10);
    expect(await slurp(whole.body)).toBe('0123456789');
    const part = await store.read('r.txt', { start: 2, end: 5 });
    expect(part.size).toBe(4);
    expect(part.entry.size).toBe(10);
    expect(await slurp(part.body)).toBe('2345');
    const clamped = await store.read('r.txt', { start: 8, end: 99 });
    expect(await slurp(clamped.body)).toBe('89');
    expect(await kindOf(store.read('r.txt', { start: 10, end: 12 }))).toBe('invalid');
    expect(await kindOf(store.read('missing.txt'))).toBe('not_found');
    await store.create('dir', 'directory');
    expect(await kindOf(store.read('dir'))).toBe('invalid');
    await store.write('empty', enc.encode(''));
    expect(await slurp((await store.read('empty')).body)).toBe('');
  });

  it('sizes the body from the opened file, so bytes appended later never exceed it', async () => {
    const oneMiB = 1024 * 1024;
    await store.write('log.txt', new Uint8Array(oneMiB));
    const opened = await store.read('log.txt');
    await appendFile(path.join(root, 'log.txt'), 'APPENDED-AFTER-OPEN');
    expect(opened.size).toBe(oneMiB);
    expect((await new Response(opened.body).arrayBuffer()).byteLength).toBe(oneMiB);
  });
});

describe('create, stat, list, delete', () => {
  it('create makes parents and conflicts on existing paths', async () => {
    await store.create('deep/er/file.txt', 'file');
    await store.create('docs', 'directory');
    expect(await disk('deep/er/file.txt')).toBe('');
    expect(await kindOf(store.create('docs', 'directory'))).toBe('conflict');
    expect(await kindOf(store.create('deep/er/file.txt', 'file'))).toBe('conflict');
    expect(await kindOf(store.create('deep/er/file.txt/x', 'file'))).toBe('conflict');
    expect(await store.stat('docs')).toMatchObject({ kind: 'directory', name: 'docs' });
    expect(await store.stat('nope/never.txt')).toBeNull();
    expect(await store.stat('deep/er/file.txt/x')).toBeNull();
  });

  it('list honours depth and excludes the start', async () => {
    await store.write('a/b/c.txt', enc.encode('c'));
    await store.write('a/d.txt', enc.encode('d'));
    expect((await store.list('', 1)).map((e) => e.path).sort()).toEqual(['a']);
    expect((await store.list('', 2)).map((e) => e.path).sort()).toEqual(['a', 'a/b', 'a/d.txt']);
    expect((await store.list('a', 1)).map((e) => e.path).sort()).toEqual(['a/b', 'a/d.txt']);
    expect(await kindOf(store.list('nope', 1))).toBe('not_found');
    expect(await kindOf(store.list('a/d.txt', 1))).toBe('invalid');
  });

  it('marks a listed directory that was not walked (a link, or unreadable) as incomplete', async () => {
    await store.write('real/sub/f.txt', enc.encode('f'));
    await store.write('locked/x.txt', enc.encode('x'));
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    await chmod(path.join(root, 'locked'), 0o000);
    try {
      const byPath = new Map((await store.list('', 2)).map((e) => [e.path, e]));
      expect(byPath.get('alias')).toMatchObject({ kind: 'directory', meta: { incomplete: true } });
      expect(byPath.get('locked')).toMatchObject({ kind: 'directory', meta: { incomplete: true } });
      expect(byPath.get('real')?.meta).toBeUndefined();
      expect(byPath.get('real/sub')?.meta).toBeUndefined(); // at the depth boundary: never walked, not incomplete
      expect([...byPath.keys()].filter((p) => p.startsWith('alias/') || p.startsWith('locked/'))).toEqual([]);
      expect((await store.list('', 1)).find((e) => e.path === 'alias')?.meta).toBeUndefined();
      expect((await store.list('alias', 1)).map((e) => e.path)).toEqual(['alias/sub']);
    } finally {
      await chmod(path.join(root, 'locked'), 0o755);
    }
  });

  it('delete removes subtrees and reports missing paths', async () => {
    await store.write('d/e/f.txt', enc.encode('f'));
    await store.delete('d');
    expect(await store.stat('d')).toBeNull();
    expect(await kindOf(store.delete('d'))).toBe('not_found');
    expect(await kindOf(store.delete(''))).toBe('invalid');
  });

  it('error messages use the relative path, never the server path', async () => {
    await store.write('a.txt', enc.encode('x'));
    const errors = [
      await fail(store.read('some/missing.txt')),
      await fail(store.list('link', 1)),
      await fail(store.create('link/x', 'file')),
      await fail(store.write('a.txt/b', enc.encode('x'))),
      await fail(store.create('a.txt', 'file')),
      await fail(store.move('some/missing.txt', 'z')),
    ];
    for (const r of errors) {
      expect(r.message).not.toContain(base);
      expect(r.message).not.toContain(root);
    }
    expect(errors[0]!.message).toContain('some/missing.txt');
  });
});

describe('move and copy', () => {
  it('conflict without overwrite leaves both unchanged; overwrite replaces', async () => {
    await store.write('x.txt', enc.encode('X'));
    await store.write('y.txt', enc.encode('Y'));
    for (const op of ['move', 'copy'] as const) {
      expect(await kindOf(store[op]('x.txt', 'y.txt'))).toBe('conflict');
      expect([await disk('x.txt'), await disk('y.txt')]).toEqual(['X', 'Y']);
    }
    expect((await store.copy('x.txt', 'y.txt', { overwrite: true })).path).toBe('y.txt');
    expect([await disk('x.txt'), await disk('y.txt')]).toEqual(['X', 'X']);
    await store.write('z.txt', enc.encode('Z'));
    await store.move('z.txt', 'y.txt', { overwrite: true });
    expect(await disk('y.txt')).toBe('Z');
    expect(await store.stat('z.txt')).toBeNull();
    expect((await store.move('x.txt', 'x.txt')).path).toBe('x.txt');
    expect(await disk('x.txt')).toBe('X');
    expect(await kindOf(store.move('ghost.txt', 'g2.txt'))).toBe('not_found');
    expect(await kindOf(store.copy('ghost.txt', 'g2.txt'))).toBe('not_found');
    await store.move('x.txt', 'new/parent/x.txt');
    await store.copy('new/parent/x.txt', 'other/parent/x.txt');
    expect([await disk('new/parent/x.txt'), await disk('other/parent/x.txt')]).toEqual(['X', 'X']);
  });

  it('overwrite of a directory replaces it and never touches the source', async () => {
    await store.write('src/keep.txt', enc.encode('k'));
    await store.write('src/sub/deep.txt', enc.encode('d'));
    await store.write('dst/stale.txt', enc.encode('s'));
    expect(await kindOf(store.copy('src', 'dst'))).toBe('conflict');
    expect(await disk('dst/stale.txt')).toBe('s');
    await store.copy('src', 'dst', { overwrite: true });
    expect((await store.list('dst', 3)).map((e) => e.path).sort()).toEqual([
      'dst/keep.txt',
      'dst/sub',
      'dst/sub/deep.txt',
    ]);
    expect((await store.list('src', 3)).map((e) => e.path).sort()).toEqual([
      'src/keep.txt',
      'src/sub',
      'src/sub/deep.txt',
    ]);
    expect((await readdir(root)).sort()).toEqual(['dst', 'link', 'src']);
    await store.write('file.txt', enc.encode('f'));
    await store.move('file.txt', 'dst', { overwrite: true }); // file replaces a directory
    expect(await disk('dst')).toBe('f');
    await store.move('src', 'dst', { overwrite: true }); // directory replaces a file
    expect(await store.stat('src')).toBeNull();
    expect(await disk('dst/keep.txt')).toBe('k');
  });

  it('moves and copies folders but not into themselves', async () => {
    await store.write('a/x.txt', enc.encode('x'));
    await store.write('a/sub/y.txt', enc.encode('y'));
    await store.move('a', 'b');
    await store.copy('b', 'c');
    expect((await store.list('', 5)).map((e) => e.path).sort()).toEqual([
      'b',
      'b/sub',
      'b/sub/y.txt',
      'b/x.txt',
      'c',
      'c/sub',
      'c/sub/y.txt',
      'c/x.txt',
    ]);
    expect(await kindOf(store.move('b', 'b/inside'))).toBe('invalid');
    expect(await kindOf(store.copy('b', 'b/inside'))).toBe('invalid');
    expect(await kindOf(store.move('b/sub', 'b', { overwrite: true }))).toBe('invalid');
    expect(await disk('b/sub/y.txt')).toBe('y');
  });

  it('copy skips excluded and temp entries inside folders', async () => {
    await store.write('a/x.txt', enc.encode('x'));
    await mkdir(path.join(root, 'a', '.git'));
    await writeFile(path.join(root, 'a', '.git', 'config'), 'c');
    await store.copy('a', 'b');
    expect(await readdir(path.join(root, 'b'))).toEqual(['x.txt']);
  });
});

describe('search', () => {
  it('matches names case-insensitively, breadth-first, up to the limit', async () => {
    await store.write('deep/er/Report.md', enc.encode('1'));
    await store.write('report-top.txt', enc.encode('2'));
    await store.write('x/REPORT2.txt', enc.encode('3'));
    expect((await store.search!('report', 10)).map((e) => e.path)).toEqual([
      'report-top.txt',
      'x/REPORT2.txt',
      'deep/er/Report.md',
    ]);
    expect(await store.search!('report', 2)).toHaveLength(2);
    expect(await store.search!('', 5)).toEqual([]);
    expect(await nodeFsStore(root, { searchLimit: 1 }).search!('report', 10)).toHaveLength(1);
  });
});

// Fix round 1: link minting, write-commit races, exclude bypass, cyclic links.
describe('escaping links', () => {
  let pkgOutside: string;
  beforeEach(async () => {
    // root/nm/.bin/cli2 -> ../pkg/cli.js is fine where it is, but escapes the root from root/<x>.
    pkgOutside = path.join(base, 'pkg');
    await mkdir(pkgOutside);
    await writeFile(path.join(pkgOutside, 'cli.js'), 'outside-orig');
    await mkdir(path.join(root, 'nm', '.bin'), { recursive: true });
    await mkdir(path.join(root, 'nm', 'pkg'));
    await writeFile(path.join(root, 'nm', 'pkg', 'cli.js'), 'inside');
    await symlink('../pkg/cli.js', path.join(root, 'nm', '.bin', 'cli2'));
  });
  const outsideIntact = async (): Promise<void> => {
    expect(await readFile(path.join(pkgOutside, 'cli.js'), 'utf8')).toBe('outside-orig');
    expect(await readdir(pkgOutside)).toEqual(['cli.js']);
  };

  it('a move that mints an escaping link during a slow write is refused and writes nothing outside', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(enc.encode('first '));
        await gate;
        c.enqueue(enc.encode('second'));
        c.close();
      },
    });
    const writing = store.write('w.txt', slow);
    await sleep(50);
    expect(await kindOf(store.move('nm/.bin/cli2', 'w.txt', { overwrite: true }))).toBe('forbidden');
    release();
    await writing;
    expect(await disk('w.txt')).toBe('first second');
    expect((await lstat(path.join(root, 'nm', '.bin', 'cli2'))).isSymbolicLink()).toBe(true);
    await outsideIntact();
  });

  it('refuses to move or copy a link to where its target would leave the root', async () => {
    expect(await kindOf(store.move('nm/.bin/cli2', 'moved'))).toBe('forbidden');
    expect(await kindOf(store.copy('nm/.bin/cli2', 'copied'))).toBe('forbidden');
    expect((await readdir(root)).sort()).toEqual(['link', 'nm']);
    expect((await lstat(path.join(root, 'nm', '.bin', 'cli2'))).isSymbolicLink()).toBe(true);
    await outsideIntact();
  });

  it('moves and copies links that stay inside the root and reports a real entry', async () => {
    const moved = await store.move('nm/.bin/cli2', 'nm/.bin/cli3');
    expect(moved).toMatchObject({ path: 'nm/.bin/cli3', name: 'cli3', kind: 'file' });
    const copied = await store.copy('nm/.bin/cli3', 'nm/.bin/cli4');
    expect(copied).toMatchObject({ path: 'nm/.bin/cli4', kind: 'file' });
    await symlink('pkg', path.join(root, 'nm', 'dirlink'));
    expect(await store.move('nm/dirlink', 'nm/dirlink2')).toMatchObject({
      path: 'nm/dirlink2',
      kind: 'directory',
    });
    await outsideIntact();
  });

  it('delete, read and write through an ancestor that became an escaping link are forbidden', async () => {
    await symlink(outside, path.join(root, 'anc'));
    expect(await kindOf(store.delete('anc/secret.txt'))).toBe('forbidden');
    expect(await kindOf(store.read('anc/secret.txt'))).toBe('forbidden');
    expect(await kindOf(store.write('anc/secret.txt', enc.encode('PWNED')))).toBe('forbidden');
    expect(await kindOf(store.create('anc/made', 'directory'))).toBe('forbidden');
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('s');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('a write whose directory is swapped for an escaping link mid-stream is forbidden', async () => {
    await store.write('dir/f.txt', enc.encode('original'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(enc.encode('new'));
        await gate;
        c.close();
      },
    });
    const writing = store.write('dir/f.txt', slow);
    await sleep(50);
    await rename(path.join(root, 'dir'), path.join(root, 'dir-moved')); // a local process, not the HTTP API
    await symlink(outside, path.join(root, 'dir'));
    release();
    expect(await kindOf(writing)).toBe('forbidden');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });
});

describe('exclude bypass', () => {
  beforeEach(async () => {
    await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), 'c');
    await writeFile(path.join(root, 'ok.txt'), 'ok');
  });

  it('matches case variants of the request path', async () => {
    expect(await kindOf(store.read('.GIT/config'))).toBe('not_found');
    expect(await kindOf(store.write('.Git/hooks/pre-commit', enc.encode('x')))).toBe('not_found');
    expect(await kindOf(store.list('.GIT', 1))).toBe('not_found');
    expect(await store.stat('.GIT')).toBeNull();
    expect(await readdir(path.join(root, '.git', 'hooks'))).toEqual([]);
  });

  it('matches NFC and NFD forms, in requests and in names read from disk', async () => {
    const nfc = 'résumé';
    const nfd = 'résumé';
    const s = nodeFsStore(root, { exclude: [nfc] });
    await mkdir(path.join(root, nfd));
    await writeFile(path.join(root, nfd, 'a.txt'), 'a');
    await writeFile(path.join(root, `${nfd}-visible.txt`), 'v');
    expect((await s.list('', 1)).map((e) => e.path).sort()).toEqual(
      ['.git', 'ok.txt', `${nfc}-visible.txt`].sort(),
    );
    expect(await kindOf(s.read(`${nfd}/a.txt`))).toBe('not_found');
    expect(await s.stat(nfd)).toBeNull();
  });

  it('returns NFC paths for names stored as NFD', async () => {
    const nfd = 'café.txt';
    await writeFile(path.join(root, nfd), 'x');
    expect((await store.list('', 1)).map((e) => e.path)).toContain('café.txt');
  });

  it('hides a symlink alias to an excluded directory', async () => {
    await symlink(path.join(root, '.git'), path.join(root, 'g'));
    expect((await store.list('', 1)).map((e) => e.path)).not.toContain('g');
    expect(await kindOf(store.read('g/config'))).toBe('not_found');
    expect(await kindOf(store.write('g/hooks/pre-commit', enc.encode('x')))).toBe('not_found');
    expect(await kindOf(store.list('g', 1))).toBe('not_found');
    expect(await store.stat('g')).toBeNull();
    expect(await kindOf(store.delete('g'))).toBe('not_found');
    expect(await store.search!('g', 10)).toEqual([]);
    expect(await readdir(path.join(root, '.git', 'hooks'))).toEqual([]);
  });

  it('copy filter is case- and normalization-insensitive', async () => {
    await mkdir(path.join(root, 'a', '.GIT'), { recursive: true });
    await writeFile(path.join(root, 'a', '.GIT', 'config'), 'c');
    await writeFile(path.join(root, 'a', 'x.txt'), 'x');
    await store.copy('a', 'b');
    expect(await readdir(path.join(root, 'b'))).toEqual(['x.txt']);
  });
});

describe('symlink cycles', () => {
  it('list and search skip cyclic links instead of failing', async () => {
    await mkdir(path.join(root, 'a'));
    await writeFile(path.join(root, 'a', 'f.txt'), 'f');
    await symlink('cyc2', path.join(root, 'a', 'cyc1'));
    await symlink('cyc1', path.join(root, 'a', 'cyc2'));
    expect((await store.list('', 10)).map((e) => e.path).sort()).toEqual(['a', 'a/f.txt']);
    expect((await store.list('a', 1)).map((e) => e.path)).toEqual(['a/f.txt']);
    expect(await store.search!('cyc', 10)).toEqual([]);
    expect((await store.search!('f.txt', 10)).map((e) => e.path)).toEqual(['a/f.txt']);
  });
});

describe('nodeFsStore with an unusable root', () => {
  it.each([undefined, ''])(
    'creates the store without throwing and rejects each operation (%j)',
    async (bad) => {
      const lazy = nodeFsStore(bad as unknown as string);
      const { kind, message } = await fail(lazy.list('', 1));
      expect(kind).toBe('unknown');
      expect(message).toContain('AGENT_WORKSPACE_DIR');
      expect(message).toMatch(/See https:\/\/\S+\/docs\/server\/handler#stores$/);
      expect(await kindOf(lazy.stat('a.txt'))).toBe('unknown');
      expect(() =>
        lazy.watch?.(
          () => undefined,
          () => undefined,
        ),
      ).toThrow(/root directory/);
    },
  );
});
