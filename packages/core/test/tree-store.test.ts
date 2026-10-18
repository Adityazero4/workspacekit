import { expect, test } from 'vitest';
import { FsError } from '../src/errors';
import { createMemoryAdapter, type MemoryAdapter } from '../src/memory';
import { entryAt, statusOf, type TreeData } from '../src/tree/model';
import { createTreeStore, type TreeStore } from '../src/tree/store';
import type { ChangeEvent, Entry, FileSystemAdapter } from '../src/types';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const allPaths = (t: TreeData): string[] => [...t.folders.values()].flatMap((n) => [...n.children.values()].map((e) => e.path));
const names = (s: TreeStore): string[] => allPaths(s.getSnapshot().tree).sort();
const tree = (s: TreeStore): TreeData => s.getSnapshot().tree;
const kids = (s: TreeStore, p: string): string[] => [...(tree(s).folders.get(p)?.children.values() ?? [])].map((e) => e.path);

/** Wraps an adapter: records `list` calls, drops `watch` (so tests control events), allows per-method overrides. */
function wrap(inner: FileSystemAdapter, over: Partial<FileSystemAdapter> = {}): FileSystemAdapter & { lists: string[] } {
  const lists: string[] = [];
  const a: FileSystemAdapter & { lists: string[] } = {
    ...inner,
    lists,
    list: (p, o) => {
      lists.push(p);
      return inner.list(p, o);
    },
    ...over,
  };
  delete a.watch;
  return a;
}

/** `list` results are computed at call time but only delivered when released. */
function gated(inner: FileSystemAdapter): FileSystemAdapter & { held: { path: string; release(): void }[] } {
  const held: { path: string; release(): void }[] = [];
  const a = wrap(inner, {
    list: (p, o) => {
      const real = inner.list(p, o);
      return new Promise<Entry[]>((res, rej) => held.push({ path: p, release: () => void real.then(res, rej) }));
    },
  });
  return Object.assign(a, { held });
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const seed = (): MemoryAdapter =>
  createMemoryAdapter({ files: { 'a/b/c.txt': 'c', 'a/x.txt': 'x', 'd.txt': 'd', 'dir/one.txt': '1' } });

test('loadFolder fetches depth 2 and expanding a child inside the window needs no request', async () => {
  const inner = seed();
  const depths: number[] = [];
  const a = wrap(inner, { list: (p, o) => (depths.push(o.depth), a.lists.push(p), inner.list(p, o)) });
  const s = createTreeStore(a);
  await s.loadFolder('');
  expect(a.lists).toEqual(['']);
  expect(depths).toEqual([2]);
  expect(statusOf(tree(s), 'a')).toBe('loaded');
  await s.loadFolder('a');
  expect(a.lists).toEqual(['']);
  await s.loadFolder('a/b'); // beyond the window
  expect(a.lists).toEqual(['', 'a/b']);
});

test('dedupes concurrent loads', async () => {
  const a = wrap(seed());
  const s = createTreeStore(a);
  await Promise.all([s.loadFolder('a'), s.loadFolder('a')]);
  expect(a.lists).toEqual(['a']);
});

test('drops a stale listing response', async () => {
  const mem = seed();
  const g = gated(mem);
  const s = createTreeStore(g);
  const first = s.loadFolder('a', { force: true });
  await mem.create!('a/new.txt', 'file');
  const second = s.loadFolder('a', { force: true });
  expect(g.held.map((h) => h.path)).toEqual(['a', 'a']);
  g.held[1]!.release();
  await second;
  expect(names(s)).toContain('a/new.txt');
  g.held[0]!.release(); // older response lands last (and lacks new.txt)
  await first;
  expect(names(s)).toContain('a/new.txt');
});

test('error is per folder', async () => {
  const inner = seed();
  const seen: FsError[] = [];
  const a = wrap(inner, {
    list: (p, o) => (p === 'a' ? Promise.reject(new FsError('forbidden', 'nope')) : inner.list(p, o)),
  });
  const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
  await s.loadFolder('');
  await s.loadFolder('a');
  const snap = s.getSnapshot();
  expect(snap.errors.get('a')?.kind).toBe('forbidden');
  expect(statusOf(snap.tree, 'a')).toBe('error');
  expect(statusOf(snap.tree, '')).toBe('loaded');
  expect(seen).toHaveLength(1);
});

test('optimistic create shows immediately, confirms, and rolls back on failure', async () => {
  const mem = seed();
  const d = deferred<Entry>();
  let mode: 'ok' | 'fail' = 'ok';
  const a = wrap(mem, { create: (p, k) => (mode === 'ok' ? mem.create!(p, k).then((e) => d.promise.then(() => e)) : d.promise) });
  const s = createTreeStore(a);
  await s.loadFolder('');
  const p = s.create('', 'new.txt', 'file');
  await settle();
  expect(names(s)).toContain('new.txt');
  expect(s.getSnapshot().pending.has('new.txt')).toBe(true);
  d.resolve({ path: 'new.txt', name: 'new.txt', kind: 'file' });
  expect((await p).path).toBe('new.txt');
  expect(names(s)).toContain('new.txt');
  expect(s.getSnapshot().pending.size).toBe(0);

  mode = 'fail';
  const f = deferred<Entry>();
  const b = wrap(mem, { create: () => f.promise });
  const s2 = createTreeStore(b);
  await s2.loadFolder('');
  const p2 = s2.create('', 'zzz.txt', 'file');
  const caught = p2.catch((e: unknown) => e);
  await settle();
  expect(names(s2)).toContain('zzz.txt');
  f.reject(new FsError('forbidden', 'no'));
  const err = await caught;
  expect(err).toBeInstanceOf(FsError);
  expect((err as FsError).kind).toBe('forbidden');
  expect(names(s2)).not.toContain('zzz.txt');
  expect(s2.getSnapshot().pending.size).toBe(0);
});

test('a listing that lands while a create is in flight survives the create rollback', async () => {
  const mem = seed();
  const f = deferred<Entry>();
  const a = wrap(mem, { create: () => f.promise });
  const s = createTreeStore(a);
  await s.loadFolder('');
  const caught = s.create('', 'tmp.txt', 'file').catch((e: unknown) => e);
  await settle();
  await mem.create!('late.txt', 'file'); // someone else's file appears
  // the listing replaces the optimistic entry and brings in late.txt
  await s.loadFolder('', { force: true });
  expect(names(s)).toContain('late.txt');
  f.reject(new FsError('unknown', 'boom'));
  await caught;
  expect(names(s)).toContain('late.txt');
  expect(names(s)).not.toContain('tmp.txt');
});

test('create rejects duplicates without calling the adapter, and unsupported ops reject', async () => {
  const calls: string[] = [];
  const mem = seed();
  const a = wrap(mem, { create: (p, k) => (calls.push(p), mem.create!(p, k)) });
  const s = createTreeStore(a);
  await expect(s.create('', 'D.TXT', 'file')).rejects.toMatchObject({ kind: 'conflict' });
  expect(calls).toEqual([]);
  const ro = createTreeStore(wrap(mem, { create: undefined, move: undefined, copy: undefined, delete: undefined }));
  await ro.loadFolder('');
  for (const op of [
    () => ro.create('', 'q', 'file'),
    () => ro.rename('d.txt', 'e.txt'),
    () => ro.move('d.txt', 'dir'),
    () => ro.copy('d.txt', 'dir'),
    () => ro.duplicate('d.txt'),
    () => ro.remove('d.txt'),
  ]) {
    await expect(op()).rejects.toMatchObject({ kind: 'invalid', message: 'operation not supported' });
  }
});

test('remove hides subtree immediately and restores on failure', async () => {
  const mem = seed();
  const f = deferred<void>();
  const a = wrap(mem, { delete: () => f.promise });
  const s = createTreeStore(a);
  await s.loadFolder('');
  await s.loadFolder('a/b');
  const before = names(s);
  expect(before).toContain('a/b/c.txt');
  const caught = s.remove('a').catch((e: unknown) => e);
  await settle();
  expect(names(s).filter((n) => n === 'a' || n.startsWith('a/'))).toEqual([]);
  f.reject(new FsError('forbidden', 'no'));
  expect(await caught).toBeInstanceOf(FsError);
  expect(names(s)).toEqual(before);
  expect(tree(s).folders.get('')?.children.has('a')).toBe(true);
});

test('remove, move and rename of the root reject with invalid before any optimistic change', async () => {
  const a = wrap(seed(), {
    delete: () => Promise.reject(new Error('must not be called')),
    move: () => Promise.reject(new Error('must not be called')),
  });
  const s = createTreeStore(a);
  await s.loadFolder('');
  const before = s.getSnapshot();
  for (const call of [() => s.remove(''), () => s.move('', 'dir'), () => s.rename('', 'x')]) {
    await expect(call()).rejects.toMatchObject({ kind: 'invalid' });
    expect(s.getSnapshot()).toBe(before);
  }
});

test('remove succeeds and reconciles', async () => {
  const s = createTreeStore(wrap(seed()));
  await s.loadFolder('');
  await s.remove('a');
  expect(names(s)).toEqual(['d.txt', 'dir', 'dir/one.txt']);
});

test('move into a folder with a same-name entry rejects with conflict and changes nothing; overwrite succeeds', async () => {
  const mem = createMemoryAdapter({ files: { 'x.txt': 'src', 'dir/x.txt': 'dst' } });
  const s = createTreeStore(wrap(mem));
  await s.loadFolder('');
  const before = names(s);
  await expect(s.move('x.txt', 'dir')).rejects.toMatchObject({ kind: 'conflict' });
  expect(names(s)).toEqual(before);
  const moved = await s.move('x.txt', 'dir', { overwrite: true });
  expect(moved.path).toBe('dir/x.txt');
  expect(names(s)).toEqual(['dir', 'dir/x.txt']);
  expect(await mem.read('dir/x.txt', 'text')).toBe('src');
});

test('a failed overwrite move restores both the source and the replaced entry', async () => {
  const mem = createMemoryAdapter({ files: { 'x.txt': 'src', 'dir/x.txt': 'dst' } });
  const s = createTreeStore(wrap(mem, { move: () => Promise.reject(new FsError('unknown', 'x')) }));
  await s.loadFolder('');
  const before = names(s);
  await expect(s.move('x.txt', 'dir', { overwrite: true })).rejects.toBeInstanceOf(FsError);
  expect(names(s)).toEqual(before);
});

test('move validates: into itself rejects without the adapter, same folder is a no-op', async () => {
  const mem = seed();
  const calls: string[] = [];
  const s = createTreeStore(wrap(mem, { move: (f, t) => (calls.push(f), mem.move!(f, t)) }));
  await s.loadFolder('');
  await expect(s.move('a', 'a/b')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(s.move('a', 'a')).rejects.toMatchObject({ kind: 'invalid' });
  const same = await s.move('d.txt', '');
  expect(same.path).toBe('d.txt');
  expect(calls).toEqual([]);
});

test('move into an unloaded folder loads it first and moves a directory with its subtree', async () => {
  const s = createTreeStore(wrap(seed()), { fetchDepth: 1 });
  await s.loadFolder('');
  const e = await s.move('a', 'dir');
  expect(e.path).toBe('dir/a');
  expect(tree(s).folders.get('')?.children.has('a')).toBe(false);
  expect(new Set(kids(s, 'dir'))).toEqual(new Set(['dir/one.txt', 'dir/a']));
});

test('copy into same folder creates "x copy" and never raises a conflict', async () => {
  const mem = seed();
  const s = createTreeStore(wrap(mem));
  await s.loadFolder('');
  expect((await s.copy('d.txt', '')).path).toBe('d copy.txt');
  expect((await s.duplicate('d.txt')).path).toBe('d copy 2.txt');
  expect(names(s)).toEqual(expect.arrayContaining(['d.txt', 'd copy.txt', 'd copy 2.txt']));
  expect(await mem.read('d copy.txt', 'text')).toBe('d');
  // other folder, not loaded yet (beyond the window): loaded first so a taken name is avoided
  await mem.create!('a/b/d.txt', 'file');
  const c = await s.copy('d.txt', 'a/b');
  expect(c.path).toBe('a/b/d copy.txt');
  expect((await s.copy('a/x.txt', 'dir')).path).toBe('dir/x.txt');
});

test('copy rejects copying a folder into itself', async () => {
  const s = createTreeStore(wrap(seed()));
  await s.loadFolder('');
  await expect(s.copy('a', 'a/b')).rejects.toMatchObject({ kind: 'invalid' });
});

test('rename validates with validateName and rejects duplicates without calling the adapter', async () => {
  const mem = seed();
  const calls: string[] = [];
  const s = createTreeStore(wrap(mem, { move: (f, t, o) => (calls.push(f), mem.move!(f, t, o)) }));
  await s.loadFolder('');
  await expect(s.rename('d.txt', 'DIR')).rejects.toMatchObject({ kind: 'conflict' });
  await expect(s.rename('d.txt', 'a/b')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(s.rename('d.txt', '  ')).rejects.toMatchObject({ kind: 'invalid' });
  expect(calls).toEqual([]);
  expect((await s.rename('d.txt', 'd.txt')).path).toBe('d.txt'); // no-op
  expect(calls).toEqual([]);
  const r = await s.rename('d.txt', 'e.txt');
  expect(r.path).toBe('e.txt');
  expect(names(s)).toContain('e.txt');
  expect(names(s)).not.toContain('d.txt');
  await s.rename('e.txt', 'E.txt'); // case-only rename of itself is not a duplicate
  expect(names(s)).toContain('E.txt');
});

test('applyChanges: deleted removes, moved remaps, actors other than user go to changed', async () => {
  const s = createTreeStore(wrap(seed()));
  await s.loadFolder('');
  s.applyChanges([{ type: 'deleted', path: 'd.txt', actor: 'external' }]);
  expect(names(s)).not.toContain('d.txt');
  s.getSnapshot().changed.has('d.txt') && expect.fail('deleted must not be changed');
  s.applyChanges([{ type: 'moved', path: 'dir/b', oldPath: 'a/b', actor: 'external' }]);
  expect(names(s)).toEqual(expect.arrayContaining(['dir/b']));
  expect(s.getSnapshot().changed.has('dir/b')).toBe(true);
  s.applyChanges([{ type: 'moved', path: 'dir/b', oldPath: 'a/b', actor: 'user' }]);
  s.applyChanges([{ type: 'deleted', path: 'dir/b' }]);
  expect(s.getSnapshot().changed.has('dir/b')).toBe(false);
  expect(names(s)).not.toContain('dir/b');
});

test('applyChanges: 5,000 events in one batch cause one reload per loaded parent and one notification', async () => {
  const mem = seed();
  const g = gated(mem);
  const s = createTreeStore(g);
  const p = s.loadFolder('');
  g.held.shift()!.release();
  await p;
  let notified = 0;
  s.subscribe(() => notified++);
  const events: ChangeEvent[] = [];
  for (let i = 0; i < 2500; i++) events.push({ type: 'created', path: `dir/n${i}.txt`, actor: 'external' });
  for (let i = 0; i < 2500; i++) events.push({ type: 'updated', path: `a/u${i}.txt` });
  events.push({ type: 'created', path: 'unloaded/deep/x.txt', actor: 'external' }); // parent not loaded: ignored
  const before = s.getSnapshot();
  s.applyChanges(events);
  await settle();
  expect(notified).toBe(1);
  expect(s.getSnapshot()).not.toBe(before);
  expect(g.held.map((h) => h.path).sort()).toEqual(['a', 'dir']);
  expect(s.getSnapshot().changed.size).toBe(2500);
  expect(s.getSnapshot().changed.has('unloaded/deep/x.txt')).toBe(false);
  g.held.forEach((h) => h.release());
});

test('applyChanges: a path that changes kind drops the stale subtree', async () => {
  const mem = createMemoryAdapter({ files: { 'a/b/c.txt': 'c' } });
  const s = createTreeStore(wrap(mem));
  await s.loadFolder('');
  await s.loadFolder('a/b');
  expect(names(s)).toContain('a/b/c.txt');
  await mem.delete!('a/b');
  await mem.create!('a/b', 'file');
  s.applyChanges([{ type: 'created', path: 'a/b', actor: 'external' }]);
  await settle();
  const t = s.getSnapshot().tree;
  expect(entryAt(t, 'a/b')?.kind).toBe('file');
  expect(entryAt(t, 'a/b/c.txt')).toBeUndefined();
  expect(t.folders.has('a/b')).toBe(false);
  // a move into itself is ignored
  const s2 = createTreeStore(wrap(seed()));
  await s2.loadFolder('');
  s2.applyChanges([{ type: 'moved', path: 'a/b/z', oldPath: 'a/b' }]); // into itself: ignored
  expect(entryAt(tree(s2), 'a/b')).toBeDefined();
});

test('applyChanges: moved into an unloaded folder removes the entry from view', async () => {
  const s = createTreeStore(wrap(seed()), { fetchDepth: 1 });
  await s.loadFolder('');
  s.applyChanges([{ type: 'moved', path: 'dir/d.txt', oldPath: 'd.txt' }]);
  expect(names(s)).toEqual(['a', 'dir']);
});

test('markSeen removes path from changed', async () => {
  const s = createTreeStore(wrap(seed()));
  await s.loadFolder('');
  s.applyChanges([{ type: 'updated', path: 'd.txt', actor: 'external' }]);
  expect(s.getSnapshot().changed.has('d.txt')).toBe(true);
  s.markSeen('d.txt');
  expect(s.getSnapshot().changed.has('d.txt')).toBe(false);
  const snap = s.getSnapshot();
  s.markSeen('d.txt');
  expect(s.getSnapshot()).toBe(snap);
});

test('subscribe notifies once per state change; getSnapshot is referentially stable between changes', async () => {
  const s = createTreeStore(wrap(seed()));
  let n = 0;
  const off = s.subscribe(() => n++);
  const a = s.getSnapshot();
  expect(s.getSnapshot()).toBe(a);
  await s.loadFolder('');
  await settle();
  const b = s.getSnapshot();
  expect(b).not.toBe(a);
  expect(b.version).toBeGreaterThan(a.version);
  expect(s.getSnapshot()).toBe(b);
  const during = n;
  s.applyChanges([{ type: 'updated', path: 'd.txt', actor: 'external' }]);
  s.markSeen('d.txt');
  await Promise.resolve();
  expect(n).toBe(during + 1); // two commits in one tick, one notification
  off();
  s.markSeen('nothing');
  s.applyChanges([{ type: 'updated', path: 'd.txt', actor: 'external' }]);
  await settle();
  expect(n).toBe(during + 1);
});

test('subscribes to adapter.watch and dispose stops everything', async () => {
  const mem = seed();
  const s = createTreeStore(mem);
  await s.loadFolder('');
  await mem.create!('fresh.txt', 'file');
  await settle();
  expect(names(s)).toContain('fresh.txt');
  let n = 0;
  s.subscribe(() => n++);
  s.dispose();
  await mem.create!('later.txt', 'file');
  await settle();
  expect(names(s)).not.toContain('later.txt');
  expect(n).toBe(0);
});

/** `list(heldPath)` is computed immediately but delivered only on release. Records every `list` call. */
function holdPath(inner: FileSystemAdapter, heldPath: string): FileSystemAdapter & { lists: string[]; release(): void } {
  const held: (() => void)[] = [];
  const a = wrap(inner, {
    list: (p, o) => {
      a.lists.push(p);
      const real = inner.list(p, o);
      return p === heldPath ? new Promise<Entry[]>((res, rej) => held.push(() => void real.then(res, rej))) : real;
    },
  });
  return Object.assign(a, { release: () => held.splice(0).forEach((r) => r()) });
}
const noTrace = (s: TreeStore, prefix: string): void => {
  const t = s.getSnapshot().tree;
  const under = (p: string): boolean => p === prefix || p.startsWith(prefix + '/');
  expect(allPaths(t).filter(under)).toEqual([]);
  expect([...t.folders.keys()].filter(under)).toEqual([]); // no children and no status left behind
  expect(t.folders.get('')?.children.has(prefix)).toBe(false);
};

test('a listing in flight for a folder that is then removed does not resurrect it', async () => {
  const h = holdPath(createMemoryAdapter({ files: { 'a/x.txt': 'x', 'd.txt': 'd' } }), 'a');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  const load = s.loadFolder('a');
  await s.remove('a');
  h.release();
  await load;
  noTrace(s, 'a');
  await s.loadFolder('', { force: true });
  noTrace(s, 'a');
});

test('a listing in flight for a folder deleted by a change event does not resurrect it', async () => {
  const h = holdPath(createMemoryAdapter({ files: { 'a/x.txt': 'x', 'd.txt': 'd' } }), 'a');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  const load = s.loadFolder('a');
  s.applyChanges([{ type: 'deleted', path: 'a', actor: 'external' }]);
  h.release();
  await load;
  noTrace(s, 'a');
});

test('a listing in flight for a folder that is then moved does not leave a ghost at the old path', async () => {
  const h = holdPath(createMemoryAdapter({ files: { 'a/x.txt': 'x', 'b/y.txt': 'y' } }), 'a');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  const load = s.loadFolder('a');
  await s.move('a', 'b');
  h.release();
  await load;
  noTrace(s, 'a');
  expect(entryAt(tree(s), 'b/a')).toBeDefined();
  expect(statusOf(tree(s), 'b/a')).not.toBe('loading');
});

test('a folder removed and recreated with the same name does not show deleted contents', async () => {
  const mem = createMemoryAdapter({ files: { 'a/x.txt': 'x' } });
  const h = holdPath(mem, 'a');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  const load = s.loadFolder('a');
  await s.remove('a');
  await s.create('', 'a', 'directory');
  h.release();
  await load;
  expect(kids(s, 'a')).toEqual([]);
});

test('overwrite-move rollback after a destination listing landed restores source and destination', async () => {
  const mem = createMemoryAdapter({ files: { 'x.txt': 'src', 'dir/x.txt': 'dst' } });
  const f = deferred<Entry>();
  let hold = false;
  const held: (() => void)[] = [];
  const a = wrap(mem, {
    move: () => f.promise,
    list: (p, o) => {
      const real = mem.list(p, o);
      return hold ? new Promise<Entry[]>((res, rej) => held.push(() => void real.then(res, rej))) : real;
    },
  });
  const s = createTreeStore(a);
  await s.loadFolder('');
  const origSrc = entryAt(tree(s), 'x.txt')!;
  const origDst = entryAt(tree(s), 'dir/x.txt')!;
  const caught = s.move('x.txt', 'dir', { overwrite: true }).catch((e: unknown) => e);
  await settle();
  expect(entryAt(tree(s), 'x.txt')).toBeUndefined();
  await s.loadFolder('dir', { force: true }); // destination listing lands mid-mutation: the real dst entry is back
  expect(entryAt(tree(s), 'dir/x.txt')).toEqual(origDst);
  hold = true; // keep the post-failure reload from masking the rollback
  f.reject(new FsError('unknown', 'boom'));
  await settle();
  const t = s.getSnapshot().tree;
  expect(entryAt(t, 'x.txt')).toEqual(origSrc);
  expect(entryAt(t, 'dir/x.txt')).toEqual(origDst);
  expect(held.length).toBeGreaterThan(0); // the failure triggered a reload
  held.splice(0).forEach((r) => r());
  expect(await caught).toBeInstanceOf(FsError);
});

test('applyChanges: resync reloads every loaded folder once, even when repeated', async () => {
  const g = gated(seed());
  const s = createTreeStore(g);
  const p = s.loadFolder('');
  g.held.shift()!.release();
  await p;
  const loaded = [...tree(s).folders.values()].filter((n) => n.status === 'loaded').map((n) => n.path).sort();
  expect(loaded.length).toBeGreaterThan(1);
  g.held.length = 0;
  s.applyChanges([{ type: 'resync', path: '' }, { type: 'resync', path: '' }]);
  await settle();
  expect(g.held.map((h) => h.path).sort()).toEqual(loaded);
  g.held.forEach((h) => h.release());
});

test("applyChanges: 'created' discards an in-flight listing for that path and requests an asked-for folder again; 'updated' does not", async () => {
  const mem = seed();
  const h = holdPath(mem, 'a/b');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  await s.loadFolder('a');
  const load = s.loadFolder('a/b'); // its response is computed now: it lists c.txt
  expect(statusOf(tree(s), 'a/b')).toBe('loading');
  await mem.delete!('a/b');
  await mem.create!('a/b/new.txt', 'file');
  h.lists.length = 0;
  s.applyChanges([{ type: 'created', path: 'a/b', actor: 'external' }]); // recreated: the old listing is stale
  expect(h.lists).toContain('a/b'); // asked for, so requested again
  expect(statusOf(tree(s), 'a/b')).toBe('loading');
  h.release();
  await load;
  await settle();
  expect(statusOf(tree(s), 'a/b')).toBe('loaded');
  expect(entryAt(tree(s), 'a/b/c.txt')).toBeUndefined();
  expect(entryAt(tree(s), 'a/b/new.txt')).toBeDefined();

  await mem.create!('a/b/later.txt', 'file');
  const again = s.loadFolder('a/b', { force: true });
  s.applyChanges([{ type: 'updated', path: 'a/b', actor: 'external' }]);
  h.release();
  await again;
  await settle();
  expect(statusOf(tree(s), 'a/b')).toBe('loaded');
  expect(entryAt(tree(s), 'a/b/later.txt')).toBeDefined();
});

test('copying a folder while it loads keeps its status and its listing', async () => {
  const h = holdPath(createMemoryAdapter({ files: { 'a/x.txt': 'x', 'dir/y.txt': 'y' } }), 'a');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  const load = s.loadFolder('a');
  expect(statusOf(tree(s), 'a')).toBe('loading');
  expect((await s.copy('a', 'dir')).path).toBe('dir/a');
  expect(statusOf(tree(s), 'a')).toBe('loading');
  h.release();
  await load;
  expect(statusOf(tree(s), 'a')).toBe('loaded');
  expect(entryAt(tree(s), 'a/x.txt')).toBeDefined();
});

test('applyChanges: resyncs coalesce into one pass in flight plus one pending pass; loading folders are re-requested', async () => {
  const g = gated(seed());
  const s = createTreeStore(g);
  const p = s.loadFolder('');
  g.held.shift()!.release();
  await p;
  void s.loadFolder('a/b'); // in flight (never released): 'loading' at resync time
  expect(statusOf(tree(s), 'a/b')).toBe('loading');
  g.held.length = 0;
  const all = ['', 'a', 'a/b', 'dir'];
  s.applyChanges([{ type: 'resync', path: '' }]);
  await settle();
  expect(g.held.map((h) => h.path).sort()).toEqual(all);
  const first = g.held.splice(0);
  s.applyChanges([{ type: 'resync', path: '' }]);
  s.applyChanges([{ type: 'resync', path: '' }, { type: 'created', path: 'dir/n.txt' }]);
  await settle();
  expect(g.held).toEqual([]); // a pass is in flight: later resyncs only set the pending flag
  first.forEach((h) => h.release());
  await settle();
  expect(g.held.map((h) => h.path).sort()).toEqual(all); // exactly one more pass
  g.held.splice(0).forEach((h) => h.release());
  await settle();
  expect(g.held).toEqual([]);
  expect(statusOf(tree(s), 'a/b')).toBe('loaded');
});

test('applyChanges: a moved folder whose own entry is not loaded still carries its loaded descendants', async () => {
  const mem = createMemoryAdapter({ files: { 'x/b/c/f.txt': 'f', 'dir/one.txt': '1' } });
  const s = createTreeStore(wrap(mem), { fetchDepth: 1 });
  await s.loadFolder('');
  await s.loadFolder('dir');
  await s.loadFolder('x/b'); // opened directly (e.g. from search): 'x' itself was never listed
  await s.loadFolder('x/b/c');
  expect(entryAt(tree(s), 'x/b')).toBeUndefined();
  await mem.move!('x/b', 'dir/b');
  s.applyChanges([{ type: 'moved', oldPath: 'x/b', path: 'dir/b', actor: 'external' }]);
  expect([...tree(s).folders.keys()].filter((k) => k.startsWith('x/'))).toEqual([]);
  expect(statusOf(tree(s), 'dir/b')).toBe('loaded');
  expect(statusOf(tree(s), 'dir/b/c')).toBe('loaded');
  expect(entryAt(tree(s), 'dir/b/c/f.txt')?.path).toBe('dir/b/c/f.txt');
  await settle(); // the parent reload brings the moved folder's own entry
  expect(entryAt(tree(s), 'dir/b')?.kind).toBe('directory');
  expect(statusOf(tree(s), 'dir/b/c')).toBe('loaded');
});

test('applyChanges: marks below a deleted folder are dropped and marks below a moved folder follow it', async () => {
  const s = createTreeStore(wrap(seed()));
  await s.loadFolder('');
  s.applyChanges([
    { type: 'updated', path: 'a/x.txt', actor: 'external' },
    { type: 'updated', path: 'dir/one.txt', actor: 'external' },
    { type: 'updated', path: 'd.txt', actor: 'external' },
  ]);
  s.applyChanges([
    { type: 'deleted', path: 'a' },
    { type: 'moved', oldPath: 'dir', path: 'dir2' },
    { type: 'deleted', path: 'd.txt/nope' },
  ]);
  expect([...s.getSnapshot().changed].sort()).toEqual(['d.txt', 'dir2/one.txt']);
  s.applyChanges([{ type: 'deleted', path: 'd.txt' }]);
  expect([...s.getSnapshot().changed]).toEqual(['dir2/one.txt']);
});

test('renaming in place a folder whose parent was never listed keeps its loaded subfolders', async () => {
  const mem = createMemoryAdapter({ files: { 'x/b/c/f.txt': 'f', 'd.txt': 'd' } });
  const s = createTreeStore(wrap(mem), { fetchDepth: 1 });
  await s.loadFolder('');
  await s.loadFolder('x/b'); // opened from search: 'x' itself was never listed
  await s.loadFolder('x/b/c');
  await mem.move!('x/b', 'x/r');
  s.applyChanges([{ type: 'moved', oldPath: 'x/b', path: 'x/r', actor: 'external' }]);
  expect([...tree(s).folders.keys()].sort()).toEqual(['', 'x/r', 'x/r/c']);
  expect(statusOf(tree(s), 'x/r')).toBe('loaded');
  expect(statusOf(tree(s), 'x/r/c')).toBe('loaded');
  expect(entryAt(tree(s), 'x/r/c/f.txt')?.path).toBe('x/r/c/f.txt');
});

test('a parent reload does not discard an in-flight listing of a folder opened from search', async () => {
  const h = holdPath(createMemoryAdapter({ files: { 'x/b/c/f.txt': 'f', 'd.txt': 'd' } }), 'x/b/c');
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  const load = s.loadFolder('x/b/c'); // in flight; 'x' and 'x/b' were never listed
  s.applyChanges([{ type: 'created', path: 'new.txt', actor: 'external' }]); // reloads the root
  await settle();
  h.release();
  await load;
  expect(statusOf(tree(s), 'x/b/c')).toBe('loaded');
  expect(entryAt(tree(s), 'x/b/c/f.txt')).toBeDefined();
});

for (const mode of ['raced', 'not_found'] as const) {
  test(`an explicit listing in flight below a folder deleted without an event lands as the server answered it (${mode})`, async () => {
    const mem = createMemoryAdapter({ files: { 'a/b/f.txt': 'f', 'd.txt': 'd' } });
    const held: (() => void)[] = [];
    const seen: FsError[] = [];
    const a = wrap(mem, {
      list: (p, o) => {
        if (p !== 'a/b') return mem.list(p, o);
        const real = mode === 'raced' ? mem.list(p, o) : undefined; // raced: answered before the delete
        return new Promise<Entry[]>((res, rej) => held.push(() => void (real ?? mem.list(p, o)).then(res, rej)));
      },
    });
    const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
    await s.loadFolder('');
    await s.loadFolder('a');
    const load = s.loadFolder('a/b'); // expanded, in flight
    await mem.delete!('a'); // no watcher event for it
    s.applyChanges([{ type: 'created', path: 'new.txt', actor: 'external' }]); // reloads the root, which no longer lists 'a'
    await settle();
    expect([...tree(s).folders.keys()]).toEqual(['']);
    held.forEach((r) => r());
    await load;
    await settle();
    expect(entryAt(tree(s), 'a')).toBeUndefined();
    if (mode === 'raced') {
      // applied as answered: an invisible orphan (the root reload already came after it), dropped by the next root listing
      expect(statusOf(tree(s), 'a/b')).toBe('loaded');
      expect(seen).toEqual([]);
      await s.loadFolder('', { force: true });
      expect([...tree(s).folders.keys()]).toEqual(['']);
    } else {
      expect(statusOf(tree(s), 'a/b')).toBe('error');
      expect(s.getSnapshot().errors.get('a/b')?.kind).toBe('not_found');
      expect(seen.map((e) => e.kind)).toEqual(['not_found']);
    }
  });
}

test('opening from search a folder the stale root listing lacks loads it at once and reloads that listing once in the background', async () => {
  const mem = createMemoryAdapter({ files: { 'd.txt': 'd' } });
  const h = holdPath(mem, '');
  const s = createTreeStore(h, { fetchDepth: 1 });
  const first = s.loadFolder('');
  h.release();
  await first;
  await mem.create!('x/b/c/f.txt', 'file'); // created outside, no event: the root listing is stale
  h.lists.length = 0;
  await s.loadFolder('x/b/c');
  expect(statusOf(tree(s), 'x/b/c')).toBe('loaded'); // not waiting for the root reload
  expect(entryAt(tree(s), 'x/b/c/f.txt')).toBeDefined();
  expect(h.lists).toEqual(['x/b/c', '']);
  h.release();
  await settle();
  expect(entryAt(tree(s), 'x')?.kind).toBe('directory');
  expect(statusOf(tree(s), 'x/b/c')).toBe('loaded');
  expect(h.lists).toEqual(['x/b/c', '']);
  expect(s.getSnapshot().errors.size).toBe(0);
});

test('an explicitly opened folder that does not exist fails with the adapter not_found and reloads nothing', async () => {
  const seen: FsError[] = [];
  const a = wrap(createMemoryAdapter({ files: { 'd.txt': 'd' } }));
  const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
  await s.loadFolder('');
  a.lists.length = 0;
  await s.loadFolder('x/b/c');
  await settle();
  expect(a.lists).toEqual(['x/b/c']);
  expect(statusOf(tree(s), 'x/b/c')).toBe('error');
  expect(s.getSnapshot().errors.get('x/b/c')?.kind).toBe('not_found');
  expect(seen.map((e) => e.kind)).toEqual(['not_found']);
});

test('a root reload that no longer lists a folder drops loaded folders opened from search below it; their explicit in-flight listing then fails visibly', async () => {
  const mem = createMemoryAdapter({ files: { 'a/b/c/d/f.txt': 'f', 'z.txt': 'z' } });
  const held: (() => void)[] = [];
  const seen: FsError[] = [];
  const a = wrap(mem, {
    list: (p, o) => (p !== 'a/b/c/d' ? mem.list(p, o) : new Promise<Entry[]>((res, rej) => held.push(() => void mem.list(p, o).then(res, rej)))),
  });
  const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
  await s.loadFolder('');
  await s.loadFolder('a/b/c'); // opened from search; '' lists 'a'
  const load = s.loadFolder('a/b/c/d');
  await mem.delete!('a');
  await s.loadFolder('', { force: true });
  expect([...tree(s).folders.keys()]).toEqual(['']);
  held.forEach((r) => r());
  await load;
  await settle();
  expect(statusOf(tree(s), 'a/b/c')).toBe('idle');
  expect(statusOf(tree(s), 'a/b/c/d')).toBe('error');
  expect(seen.map((e) => e.kind)).toEqual(['not_found']);
});

for (const mode of ['move-self', 'move-ancestor', 'delete'] as const) {
  test(`an explicitly opened folder under a stale root follows a move or delete that arrives before the root reload (${mode})`, async () => {
    const mem = createMemoryAdapter({ files: { 'd.txt': 'd', 'q/k.txt': 'k' } });
    const held: (() => void)[] = [];
    const seen: FsError[] = [];
    let rootCalls = 0;
    const a = wrap(mem, {
      list: (p, o) => {
        if (p !== '' || ++rootCalls !== 2) return mem.list(p, o);
        return new Promise<Entry[]>((res, rej) => held.push(() => void mem.list(p, o).then(res, rej))); // the ancestor reload
      },
    });
    const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
    await s.loadFolder('');
    await s.loadFolder('q');
    await mem.create!('x/b/c/f.txt', 'file'); // no event: the root listing is stale
    await s.loadFolder('x/b/c');
    expect(statusOf(tree(s), 'x/b/c')).toBe('loaded');
    expect(held).toHaveLength(1);
    let dest: string | undefined;
    if (mode === 'move-self') {
      await mem.move!('x/b/c', (dest = 'q/c'));
      s.applyChanges([{ type: 'moved', oldPath: 'x/b/c', path: 'q/c' }]);
    } else if (mode === 'move-ancestor') {
      await mem.move!('x', 'q/x');
      dest = 'q/x/b/c';
      s.applyChanges([{ type: 'moved', oldPath: 'x', path: 'q/x' }]);
    } else {
      await mem.delete!('x');
      s.applyChanges([{ type: 'deleted', path: 'x' }]);
    }
    const check = (): void => {
      expect(statusOf(tree(s), 'x/b/c')).toBe('idle');
      if (dest) expect(statusOf(tree(s), dest)).toBe('loaded');
      if (dest) expect(entryAt(tree(s), `${dest}/f.txt`)).toBeDefined();
    };
    check();
    held.forEach((r) => r());
    await settle();
    check();
    expect(rootCalls).toBe(2);
    expect(s.getSnapshot().errors.size).toBe(0);
    expect(seen).toEqual([]);
  });
}

test('a folder the server did not walk stays idle after the parent listing and loads on demand', async () => {
  const inner = createMemoryAdapter({ files: { 'real/f.txt': 'f', 'link/f.txt': 'f' } });
  const a = wrap(inner, {
    list: async (p, o) => {
      a.lists.push(p);
      const out = await inner.list(p, o);
      if (p !== '') return out;
      // what a server returns for a symlinked dir: listed, but its contents were not walked
      return out.filter((e) => !e.path.startsWith('link/')).map((e) => (e.path === 'link' ? { ...e, meta: { incomplete: true } } : e));
    },
  });
  const s = createTreeStore(a);
  await s.loadFolder('');
  expect(statusOf(tree(s), 'real')).toBe('loaded');
  expect(statusOf(tree(s), 'link')).toBe('idle');
  await s.loadFolder('link');
  expect(a.lists).toEqual(['', 'link']);
  expect(statusOf(tree(s), 'link')).toBe('loaded');
  expect(kids(s, 'link')).toEqual(['link/f.txt']);
});

test('concurrent explicit loads under one stale ancestor share a single reload of it', async () => {
  const mem = createMemoryAdapter({ files: { 'd.txt': 'd' } });
  const a = wrap(mem);
  const s = createTreeStore(a, { fetchDepth: 1 });
  await s.loadFolder('');
  for (let i = 0; i < 50; i++) await mem.create!(`x/s${i}/f.txt`, 'file'); // no events: the root listing is stale
  a.lists.length = 0;
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.loadFolder(`x/s${i}`)));
  expect(a.lists.filter((p) => p === '')).toEqual(['']);
  for (let i = 0; i < 50; i++) expect(statusOf(tree(s), `x/s${i}`)).toBe('loaded');
  expect(s.getSnapshot().errors.size).toBe(0);
});

test('an explicit load outside the store root rejects with invalid before any request', async () => {
  const a = wrap(createMemoryAdapter({ files: { 'a/f.txt': 'f', 'b/c/g.txt': 'g' } }));
  const s = createTreeStore(a, { root: 'a' });
  await expect(s.loadFolder('b/c')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(s.loadFolder('')).rejects.toMatchObject({ kind: 'invalid' });
  expect(a.lists).toEqual([]);
  await s.loadFolder('a');
  expect(a.lists).toEqual(['a']);
});

/** Every `list` waits in `q` and is computed when released, so it answers with the adapter's state at that moment. */
function queued(mem: FileSystemAdapter): FileSystemAdapter & { lists: string[]; q: { path: string; run(): void }[] } {
  const q: { path: string; run(): void }[] = [];
  const a = wrap(mem, {
    list: (p, o) => {
      a.lists.push(p);
      return new Promise<Entry[]>((res, rej) => q.push({ path: p, run: () => void mem.list(p, o).then(res, rej) }));
    },
  });
  return Object.assign(a, { q });
}
type Queue = { path: string; run(): void }[];
const releaseFirst = (q: Queue, path: string): void => {
  const i = q.findIndex((h) => h.path === path);
  if (i === -1) throw new Error(`nothing queued for '${path}'`);
  q.splice(i, 1)[0]!.run();
};
const drain = async (q: Queue): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    while (q.length) q.shift()!.run();
    await settle();
  }
};

const whileLoading: Record<string, (s: TreeStore, mem: MemoryAdapter, q: Queue) => Promise<void>> = {
  'a resync while its listing is in flight': async (s) => s.applyChanges([{ type: 'resync', path: '' }]),
  'a resync after it landed; its reload lands before the root reload': async (s, _m, q) => {
    releaseFirst(q, 'x/b/c');
    await settle();
    s.applyChanges([{ type: 'resync', path: '' }]);
    await settle();
    releaseFirst(q, 'x/b/c');
    await settle();
  },
  'a resync after it landed; the root reloads land before its reload': async (s, _m, q) => {
    releaseFirst(q, 'x/b/c');
    await settle();
    s.applyChanges([{ type: 'resync', path: '' }]);
    await settle();
    while (q.some((h) => h.path === '')) releaseFirst(q, '');
    await settle();
  },
  'a forced reload of it while the root reload is pending': async (s, _m, q) => {
    releaseFirst(q, 'x/b/c');
    await settle();
    void s.loadFolder('x/b/c', { force: true });
  },
  'a later root reload superseding the scheduled one': async (s, mem, q) => {
    releaseFirst(q, 'x/b/c');
    await settle();
    await mem.create!('y.txt', 'file');
    s.applyChanges([{ type: 'created', path: 'y.txt', actor: 'external' }]);
    await settle();
    releaseFirst(q, '');
    await settle();
  },
  "a 'created' event for its ancestor while its listing is in flight": async (s) => s.applyChanges([{ type: 'created', path: 'x', actor: 'external' }]),
  "a 'created' event for itself while its listing is in flight": async (s) => s.applyChanges([{ type: 'created', path: 'x/b/c', actor: 'external' }]),
  "a 'created' event for its ancestor after it landed": async (s, _m, q) => {
    releaseFirst(q, 'x/b/c');
    await settle();
    s.applyChanges([{ type: 'created', path: 'x', actor: 'external' }]);
  },
};
for (const [name, during] of Object.entries(whileLoading)) {
  test(`an explicit folder opened under a stale root ends loaded after ${name}`, async () => {
    const mem = createMemoryAdapter({ files: { 'd.txt': 'd' } });
    const a = queued(mem);
    const seen: FsError[] = [];
    const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
    const first = s.loadFolder('');
    releaseFirst(a.q, '');
    await first;
    await mem.create!('x/b/c/f.txt', 'file'); // no event: the root listing is stale
    const load = s.loadFolder('x/b/c');
    await during(s, mem, a.q);
    await drain(a.q);
    await load;
    expect(statusOf(tree(s), 'x/b/c')).toBe('loaded');
    expect(entryAt(tree(s), 'x/b/c/f.txt')).toBeDefined();
    expect(entryAt(tree(s), 'x')?.kind).toBe('directory');
    expect(s.getSnapshot().errors.size).toBe(0);
    expect(seen).toEqual([]);
  });
}

for (const order of ['root reload first', 'second wave first'] as const) {
  test(`staggered explicit loads under one stale root all end loaded with at most two root reloads (${order})`, async () => {
    const mem = createMemoryAdapter({ files: { 'd.txt': 'd' } });
    const a = queued(mem);
    const seen: FsError[] = [];
    const s = createTreeStore(a, { fetchDepth: 1, onError: (e) => seen.push(e) });
    const first = s.loadFolder('');
    releaseFirst(a.q, '');
    await first;
    for (let i = 0; i < 50; i++) await mem.create!(`x/s${i}/f.txt`, 'file'); // no events: the root listing is stale
    a.lists.length = 0;
    const wave1 = Array.from({ length: 25 }, (_, i) => s.loadFolder(`x/s${i}`));
    for (let i = 0; i < 25; i++) releaseFirst(a.q, `x/s${i}`);
    await Promise.all(wave1);
    expect(a.lists.filter((p) => p === '')).toEqual(['']); // one shared reload for the first wave
    const wave2 = Array.from({ length: 25 }, (_, i) => s.loadFolder(`x/s${25 + i}`)); // requested after that reload
    if (order === 'root reload first') releaseFirst(a.q, '');
    await settle();
    for (let i = 25; i < 50; i++) releaseFirst(a.q, `x/s${i}`);
    await Promise.all(wave2);
    await drain(a.q);
    for (let i = 0; i < 50; i++) expect(statusOf(tree(s), `x/s${i}`)).toBe('loaded');
    expect(a.lists.filter((p) => p === '').length).toBe(order === 'root reload first' ? 1 : 2);
    expect(seen).toEqual([]);
  });
}

test('a background listing never resurrects a folder that a newer ancestor listing dropped', async () => {
  const mem = createMemoryAdapter({ files: { 'a/b/f.txt': 'f', 'd.txt': 'd' } });
  const h = holdPath(mem, 'a/b'); // the a/b response is computed when requested
  const s = createTreeStore(h, { fetchDepth: 1 });
  await s.loadFolder('');
  await s.loadFolder('a');
  const first = s.loadFolder('a/b');
  h.release();
  await first;
  s.applyChanges([{ type: 'created', path: 'a/b/g.txt', actor: 'external' }]); // background reload of a/b, in flight
  await mem.delete!('a'); // no event
  await s.loadFolder('', { force: true }); // drops a and a/b
  h.release(); // the background a/b listing from before the delete lands
  await settle();
  expect([...tree(s).folders.keys()]).toEqual(['']);
  expect(statusOf(tree(s), 'a/b')).toBe('idle');
  expect(s.getSnapshot().errors.size).toBe(0);
});
