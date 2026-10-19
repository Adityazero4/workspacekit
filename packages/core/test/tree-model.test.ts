import { expect, test } from 'vitest';
import { basename } from '../src/path';
import {
  applyBatch,
  compareEntries,
  emptyTree,
  entryAt,
  flattenVisible,
  mergeListing,
  moveSubtree,
  removeSubtree,
  sortedChildren,
  statusOf,
  upsertEntry,
  type SortSpec,
  type TreeData,
  type TreeOp,
} from '../src/tree/model';
import type { Entry } from '../src/types';

const dir = (path: string): Entry => ({ path, name: basename(path), kind: 'directory' });
const file = (path: string, extra: Partial<Entry> = {}): Entry => ({
  path,
  name: basename(path),
  kind: 'file',
  ...extra,
});
const byName: SortSpec = { by: 'name', direction: 'asc' };
const allEntries = (t: TreeData): Entry[] => [...t.folders.values()].flatMap((n) => [...n.children.values()]);
const paths = (t: TreeData): string[] =>
  allEntries(t)
    .map((e) => e.path)
    .sort();
const childPaths = (t: TreeData, p: string): string[] =>
  [...(t.folders.get(p)?.children.values() ?? [])].map((e) => e.path);

function sample(): TreeData {
  let t = mergeListing(emptyTree(), '', 2, [dir('a'), dir('a/b'), file('a/x.txt')]);
  t = mergeListing(t, 'a/b', 2, [dir('a/b/c'), file('a/b/c/d.txt')]);
  return t;
}

test('mergeListing replaces only the covered slice and keeps deeper loaded entries', () => {
  let t = sample();
  expect(paths(t)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d.txt', 'a/x.txt']);
  t = mergeListing(t, '', 2, [dir('a'), dir('a/b')]);
  expect(paths(t)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d.txt']);
  expect(childPaths(t, 'a')).toEqual(['a/b']);
  expect(childPaths(t, 'a/b')).toEqual(['a/b/c']);
});

test('mergeListing drops orphans of removed folders with their status and children keys', () => {
  let t = sample();
  t = mergeListing(t, '', 2, [dir('a'), file('a/x.txt')]);
  expect(paths(t)).toEqual(['a', 'a/x.txt']);
  for (const p of ['a/b', 'a/b/c']) {
    expect(t.folders.has(p)).toBe(false);
    expect(statusOf(t, p)).toBe('idle');
  }
  expect(childPaths(t, 'a')).toEqual(['a/x.txt']);
});

test('mergeListing marks folders inside the fetched window as loaded', () => {
  const t = mergeListing(emptyTree(), '', 2, [dir('a'), dir('a/b'), file('a/x.txt')]);
  expect(statusOf(t, '')).toBe('loaded');
  expect(statusOf(t, 'a')).toBe('loaded');
  expect(statusOf(t, 'a/b')).toBe('idle');
  const t2 = mergeListing(t, 'a/b', 1, [file('a/b/f.txt')]);
  expect(statusOf(t2, 'a/b')).toBe('loaded');
  // boundary dir keeps its prior status on re-listing
  expect(statusOf(mergeListing(t2, '', 2, [dir('a'), dir('a/b')]), 'a/b')).toBe('loaded');
});

test('a parent listing never marks an incomplete directory loaded; its own listing does', () => {
  const link: Entry = { ...dir('link'), meta: { incomplete: true } };
  let t = mergeListing(emptyTree(), '', 2, [dir('a'), link, file('a/x.txt')]);
  expect(statusOf(t, 'a')).toBe('loaded');
  expect(statusOf(t, 'link')).toBe('idle');
  t = mergeListing(t, 'link', 2, [dir('link/s'), file('link/s/f.txt')]);
  expect(statusOf(t, 'link')).toBe('loaded');
  expect(statusOf(t, 'link/s')).toBe('loaded');
  // a later parent listing keeps what the folder's own listing found, nested nodes included
  for (const extra of [[], [dir('stray')]]) {
    const t2 = mergeListing(mergeListing(t, 'stray', 1, []), '', 2, [dir('a'), link, ...extra]);
    expect(statusOf(t2, 'link')).toBe('loaded');
    expect(childPaths(t2, 'link/s')).toEqual(['link/s/f.txt']);
  }
});

test('entryAt and statusOf read through the parent folder node', () => {
  const t = sample();
  expect(entryAt(t, 'a/x.txt')).toMatchObject({ path: 'a/x.txt', kind: 'file' });
  expect(entryAt(t, 'a/nope')).toBeUndefined();
  expect(entryAt(t, 'zzz/y')).toBeUndefined();
  expect(entryAt(t, '')).toBeUndefined();
  expect(statusOf(t, 'a/b')).toBe('loaded');
  expect(statusOf(t, 'zzz')).toBe('idle');
});

test('flattenVisible: folders first, numeric collation, aria positions', () => {
  const t = mergeListing(emptyTree(), '', 1, [file('file10.txt'), file('file2.txt'), dir('B'), dir('a')]);
  const rows = flattenVisible(t, { root: '', expanded: new Set(), sort: byName });
  expect(rows.map((r) => r.path)).toEqual(['a', 'B', 'file2.txt', 'file10.txt']);
  expect(rows.map((r) => r.posInSet)).toEqual([1, 2, 3, 4]);
  expect(rows.every((r) => r.setSize === 4 && r.depth === 0 && r.parentPath === '')).toBe(true);
  const desc = flattenVisible(t, { root: '', expanded: new Set(), sort: { by: 'name', direction: 'desc' } });
  expect(desc.map((r) => r.path)).toEqual(['B', 'a', 'file10.txt', 'file2.txt']);
});

test('flattenVisible only descends into expanded folders and reports depth', () => {
  const t = sample();
  const closed = flattenVisible(t, { root: '', expanded: new Set(), sort: byName });
  expect(closed.map((r) => r.path)).toEqual(['a']);
  expect(closed[0]).toMatchObject({ depth: 0, isExpanded: false, status: 'loaded' });
  const rows = flattenVisible(t, { root: '', expanded: new Set(['a', 'a/b']), sort: byName });
  expect(rows.map((r) => [r.path, r.depth, r.parentPath])).toEqual([
    ['a', 0, ''],
    ['a/b', 1, 'a'],
    ['a/b/c', 2, 'a/b'],
    ['a/x.txt', 1, 'a'],
  ]);
  expect(rows[1]).toMatchObject({ isExpanded: true, status: 'loaded', posInSet: 1, setSize: 2 });
  const sub = flattenVisible(t, { root: 'a', expanded: new Set(['a/b']), sort: byName });
  expect(sub.map((r) => [r.path, r.depth])).toEqual([
    ['a/b', 0],
    ['a/b/c', 1],
    ['a/x.txt', 0],
  ]);
});

test('compareEntries: folders first, mtime/size desc with name tiebreak, extension', () => {
  const f1 = file('a.txt', { mtimeMs: 5, size: 1 });
  const f2 = file('b.txt', { mtimeMs: 5, size: 9 });
  const f3 = file('c.md', { mtimeMs: 9, size: 1 });
  const d = dir('z');
  const sorted = (xs: Entry[], sort: SortSpec): string[] =>
    [...xs].sort((x, y) => compareEntries(x, y, sort)).map((e) => e.name);
  expect(sorted([f1, f2, f3, d], { by: 'mtime', direction: 'desc' })).toEqual([
    'z',
    'c.md',
    'a.txt',
    'b.txt',
  ]);
  expect(sorted([f1, f2, f3, d], { by: 'size', direction: 'desc' })).toEqual(['z', 'b.txt', 'a.txt', 'c.md']);
  expect(sorted([f1, f2, f3, d], { by: 'size', direction: 'asc' })).toEqual(['z', 'a.txt', 'c.md', 'b.txt']);
  expect(sorted([f1, f3, f2, d], { by: 'extension', direction: 'asc' })).toEqual([
    'z',
    'c.md',
    'a.txt',
    'b.txt',
  ]);
  expect(sorted([f1, d], { by: 'name', direction: 'desc' })).toEqual(['z', 'a.txt']);
});

test('moveSubtree remaps descendants and status keys', () => {
  const t = moveSubtree(sample(), 'a/b', 'q');
  expect(paths(t)).toEqual(['a', 'a/x.txt', 'q', 'q/c', 'q/c/d.txt']);
  expect(entryAt(t, 'q')).toMatchObject({ path: 'q', name: 'q', kind: 'directory' });
  expect(entryAt(t, 'q/c/d.txt')!.name).toBe('d.txt');
  expect(childPaths(t, '').sort()).toEqual(['a', 'q']);
  expect(childPaths(t, 'a')).toEqual(['a/x.txt']);
  expect(childPaths(t, 'q')).toEqual(['q/c']);
  expect(t.folders.has('a/b')).toBe(false);
  const moved = moveSubtree(mergeListing(sample(), 'a/b', 1, []), 'a', 'z');
  expect(statusOf(moved, 'z')).toBe('loaded');
  expect(moved.folders.has('a')).toBe(false);
  expect(statusOf(moved, 'z/b')).toBe('loaded');
});

test('move remaps loaded descendants when the folder entry is not loaded', () => {
  // 'p/a' was opened directly (e.g. from search results): its parent 'p' was never listed
  let t = mergeListing(emptyTree(), 'p/a', 2, [dir('p/a/b'), file('p/a/b/f.txt'), file('p/a/x.txt')]);
  t = mergeListing(t, 'p/a/b/deep', 1, [file('p/a/b/deep/z.txt')]); // a disconnected loaded descendant
  expect(entryAt(t, 'p/a')).toBeUndefined();
  const m = moveSubtree(t, 'p/a', 'p/r');
  expect([...m.folders.keys()].filter((k) => k.startsWith('p/a'))).toEqual([]);
  expect(statusOf(m, 'p/r')).toBe('loaded');
  expect(statusOf(m, 'p/r/b')).toBe('loaded');
  expect(statusOf(m, 'p/r/b/deep')).toBe('loaded');
  expect(entryAt(m, 'p/r/b/f.txt')).toMatchObject({ path: 'p/r/b/f.txt', name: 'f.txt' });
  expect(entryAt(m, 'p/r/b/deep/z.txt')?.path).toBe('p/r/b/deep/z.txt');
  expect(childPaths(m, 'p/r').sort()).toEqual(['p/r/b', 'p/r/x.txt']);
  expect(m.folders.get('p/r')!.path).toBe('p/r');
  expect(m.folders.has('p')).toBe(false); // no entry to place: the unloaded parent is not created
});

test('move and remove reach loaded folders below a path that has neither an entry nor a node', () => {
  // only a/b/c and a/b/c/d were opened (e.g. from search): a and a/b were never listed
  let t = mergeListing(emptyTree(), 'a/b/c', 1, [file('a/b/c/f.txt'), dir('a/b/c/d')]);
  t = mergeListing(t, 'a/b/c/d', 1, [file('a/b/c/d/g.txt')]);
  const m = moveSubtree(t, 'a/b', 'a/x');
  expect([...m.folders.keys()].sort()).toEqual(['a/x/c', 'a/x/c/d']);
  expect(statusOf(m, 'a/x/c/d')).toBe('loaded');
  expect(entryAt(m, 'a/x/c/d/g.txt')?.path).toBe('a/x/c/d/g.txt');
  expect([...removeSubtree(t, 'a/b').folders.keys()]).toEqual([]);
  // a node created by a status op later in the same batch is found as well
  const s = applyBatch(t, [
    { kind: 'remove', path: 'zz/y' },
    { kind: 'status', path: 'q/r/s', status: 'loading' },
    { kind: 'remove', path: 'q' },
  ]);
  expect(s.folders.has('q/r/s')).toBe(false);
});

test('remove and move find nodes created earlier in the same batch below a path with no entry or node', () => {
  const keys = (t: TreeData): string[] => [...t.folders.keys()].sort();
  const listing: TreeOp = { kind: 'listing', folder: 'a/b/c', depth: 1, entries: [file('a/b/c/f')] };
  expect(
    keys(
      applyBatch(emptyTree(), [
        { kind: 'status', path: 'q/r/s', status: 'loading' },
        { kind: 'remove', path: 'q' },
      ]),
    ),
  ).toEqual([]);
  expect(keys(applyBatch(emptyTree(), [listing, { kind: 'remove', path: 'a' }]))).toEqual([]);
  expect(keys(applyBatch(emptyTree(), [listing, { kind: 'move', from: 'a/b', to: 'a/x' }]))).toEqual([
    'a/x/c',
  ]);
  expect(
    keys(
      applyBatch(emptyTree(), [
        { kind: 'upsert', entry: file('b/a/c') },
        { kind: 'remove', path: 'a/b' },
        { kind: 'remove', path: 'b' },
      ]),
    ),
  ).toEqual([]);
});

test('loaded folders below an unknown path are found when they sit in the shared base map', () => {
  let t = mergeListing(emptyTree(), 'a/b/c', 1, [file('a/b/c/f.txt'), dir('a/b/c/d')]);
  t = mergeListing(t, 'a/b/c/d', 1, [file('a/b/c/d/g.txt')]);
  const based: TreeData = { folders: new Map(t.folders) }; // a plain map becomes the base of the next batch
  expect([...moveSubtree(based, 'a', 'z').folders.keys()].sort()).toEqual(['z/b/c', 'z/b/c/d']);
  expect([...removeSubtree(based, 'a/b').folders.keys()]).toEqual([]);
  // a base node dropped in an overlay ('q' goes idle) must not hide the base nodes below it
  const q: TreeData = {
    folders: new Map(
      applyBatch(emptyTree(), [
        { kind: 'status', path: 'q', status: 'loading' },
        { kind: 'listing', folder: 'q/r', depth: 1, entries: [] },
      ]).folders,
    ),
  };
  const dropped = applyBatch(q, [{ kind: 'status', path: 'q', status: 'idle' }]);
  expect([...dropped.folders.keys()]).toEqual(['q/r']);
  expect([...removeSubtree(dropped, 'q').folders.keys()]).toEqual([]);
});

test('a listing that no longer lists a directory drops loaded folders below it, even ones never reached through it', () => {
  let t = mergeListing(emptyTree(), '', 1, [dir('a'), dir('k')]);
  t = mergeListing(t, 'a/b/c', 1, [file('a/b/c/f')]); // opened from search: 'a' and 'a/b' were never listed
  t = mergeListing(t, 'k/m', 1, [file('k/m/g')]);
  t = applyBatch(t, [{ kind: 'status', path: 'a/b/c/d', status: 'loading' }]);
  const gone = mergeListing(t, '', 1, [dir('k')]);
  expect([...gone.folders.keys()].sort()).toEqual(['', 'k/m']);
  const nowFile = mergeListing(t, '', 1, [file('a'), dir('k')]); // kind change: 'a' is a file now
  expect([...nowFile.folders.keys()].sort()).toEqual(['', 'k/m']);
  const still = mergeListing(t, '', 1, [dir('a'), dir('k')]); // still listed: deeper folders survive
  expect([...still.folders.keys()].sort()).toEqual(['', 'a/b/c', 'a/b/c/d', 'k/m']);
});

test('a listing drops detached folders whose boundary dir it does not list, even ones its old listing never had', () => {
  const keys = (t: TreeData): string[] => [...t.folders.keys()].sort();
  let t = mergeListing(emptyTree(), '', 1, [file('d.txt')]); // stale: lists neither x nor y
  t = mergeListing(t, 'x', 1, [dir('x/b')]); // its parent node lacks it
  t = mergeListing(t, 'y/b/c', 1, [file('y/b/c/f')]); // no parent node at all
  for (const base of [t, { folders: new Map(t.folders) }]) {
    expect(keys(mergeListing(base, '', 1, [file('d.txt')]))).toEqual(['']);
    expect(keys(mergeListing(base, '', 1, [dir('x'), dir('y')]))).toEqual(['', 'x', 'y/b/c']);
    expect(keys(mergeListing(base, '', 1, [dir('x')]))).toEqual(['', 'x']);
    // depth 2: 'y' is inside the window (fresh node), 'y/b' sits at the boundary and keeps what is below it
    expect(keys(mergeListing(base, '', 2, [dir('y'), dir('y/b')]))).toEqual(['', 'y', 'y/b/c']);
    expect(keys(mergeListing(base, '', 2, [dir('y'), file('y/b')]))).toEqual(['', 'y']);
    expect(keys(mergeListing(base, 'y', 1, [file('y/b')]))).toEqual(['', 'x', 'y']);
  }
});

test('random batches give the same folders whether the detached-node index is carried or rebuilt from a plain map', () => {
  let seed = 7; // mulberry32, as in tree-visible.test.ts: a float LCG loses precision and repeats early
  const rnd = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
  const rp = (max: number): string => Array.from({ length: 1 + rnd(max) }, () => 'abc'[rnd(3)]).join('/');
  const op = (): TreeOp => {
    const r = rnd(10);
    if (r < 4) {
      const folder = rnd(4) ? rp(2) : '';
      const at = (q: string): string => (folder ? `${folder}/${q}` : q);
      return {
        kind: 'listing',
        folder,
        depth: 1 + rnd(2),
        entries: Array.from({ length: rnd(4) }, () => (rnd(3) ? dir(at(rp(1))) : file(at(rp(1))))),
      };
    }
    if (r < 6) {
      return {
        kind: 'status',
        path: rp(3),
        status: (['loading', 'loaded', 'error', 'idle'] as const)[rnd(4)]!,
      };
    }
    if (r < 7) return { kind: 'upsert', entry: rnd(2) ? dir(rp(3)) : file(rp(3)) };
    if (r < 8) return { kind: 'remove', path: rp(2) };
    return { kind: 'move', from: rp(2), to: rp(2) };
  };
  const keys = (t: TreeData): string => [...t.folders.keys()].sort().join(' ');
  const hist: TreeData[] = [emptyTree()];
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const t = hist[rnd(hist.length)]!;
    const ops = Array.from({ length: 1 + rnd(4) }, op);
    for (const o of ops) {
      seen.add(
        o.kind === 'listing' ? `listing:${o.depth}` : o.kind === 'status' ? `status:${o.status}` : o.kind,
      );
    }
    const got = applyBatch(t, ops);
    expect(keys(got)).toBe(keys(applyBatch({ folders: new Map(t.folders) }, ops)));
    hist.push(rnd(6) ? got : { folders: new Map(got.folders) });
    if (hist.length > 200) hist.splice(rnd(200), 1);
  }
  // every op kind, listing depth and status is exercised
  expect([...seen].sort()).toEqual([
    'listing:1',
    'listing:2',
    'move',
    'remove',
    'status:error',
    'status:idle',
    'status:loaded',
    'status:loading',
    'upsert',
  ]);
});

test('upserting a file over a loaded folder drops the folders below it', () => {
  const t = upsertEntry(sample(), file('a/b'));
  expect(entryAt(t, 'a/b')?.kind).toBe('file');
  expect([...t.folders.keys()].sort()).toEqual(['', 'a']);
});

test('removeSubtree and upsertEntry', () => {
  const t = removeSubtree(sample(), 'a/b');
  expect(paths(t)).toEqual(['a', 'a/x.txt']);
  expect(childPaths(t, 'a')).toEqual(['a/x.txt']);
  expect(t.folders.has('a/b/c')).toBe(false);
  const u = upsertEntry(t, file('a/y.txt', { size: 3 }));
  expect(childPaths(u, 'a').sort()).toEqual(['a/x.txt', 'a/y.txt']);
  const u2 = upsertEntry(u, file('a/y.txt', { size: 4 }));
  expect(entryAt(u2, 'a/y.txt')!.size).toBe(4);
  expect(u2.folders.get('a')!.children.size).toBe(2);
  expect(removeSubtree(t, 'nope')).toBe(t);
});

test('functions never mutate their input TreeData', () => {
  const t = sample();
  const snap = (x: TreeData): string =>
    JSON.stringify([...x.folders].map(([k, n]) => [k, n.path, n.status, [...n.children]]));
  const before = snap(t);
  mergeListing(t, '', 2, [dir('a'), file('a/z.txt'), file('top.txt')]);
  mergeListing(t, 'a', 1, []);
  removeSubtree(t, 'a');
  moveSubtree(t, 'a', 'm');
  upsertEntry(t, file('a/new.txt'));
  applyBatch(t, [
    { kind: 'upsert', entry: file('a/b/n.txt') },
    { kind: 'remove', path: 'a/x.txt' },
    { kind: 'move', from: 'a/b', to: 'k' },
    { kind: 'status', path: 'a', status: 'error' },
  ]);
  expect(snap(t)).toBe(before);
});

test('untouched FolderNodes keep identity across applyBatch', () => {
  let t = mergeListing(emptyTree(), '', 2, [dir('a'), dir('b'), file('a/1.txt'), file('b/2.txt'), dir('c')]);
  t = mergeListing(t, 'c', 1, [file('c/3.txt')]);
  const before = new Map(t.folders);
  const next = applyBatch(t, [
    { kind: 'upsert', entry: file('a/new.txt') },
    { kind: 'remove', path: 'a/1.txt' },
    { kind: 'upsert', entry: file('a/other.txt') },
  ]);
  expect(next).not.toBe(t);
  expect(next.folders.get('b')).toBe(before.get('b'));
  expect(next.folders.get('c')).toBe(before.get('c'));
  expect(next.folders.get('')).toBe(before.get(''));
  expect(next.folders.get('a')).not.toBe(before.get('a'));
  expect(childPaths(next, 'a').sort()).toEqual(['a/new.txt', 'a/other.txt']);
  expect(applyBatch(t, [])).toBe(t);
  expect(applyBatch(t, [{ kind: 'remove', path: 'nope/x' }])).toBe(t);
});

test('applyBatch applies ops in order against the evolving tree', () => {
  const t = applyBatch(sample(), [
    { kind: 'move', from: 'a/b', to: 'q' },
    { kind: 'upsert', entry: file('q/c/new.txt') },
    { kind: 'move', from: 'q', to: 'r' },
    { kind: 'remove', path: 'r/c/d.txt' },
    { kind: 'listing', folder: 'a', depth: 1, entries: [file('a/y.txt')] },
    { kind: 'status', path: 'r/c', status: 'error' },
  ]);
  expect(paths(t)).toEqual(['a', 'a/y.txt', 'r', 'r/c', 'r/c/new.txt']);
  expect(statusOf(t, 'r/c')).toBe('error');
  expect(statusOf(t, 'a')).toBe('loaded');
});

test('status op: idle drops an empty node, other statuses create or update it without touching children', () => {
  const t = sample();
  const loading = applyBatch(t, [{ kind: 'status', path: 'z', status: 'loading' }]);
  expect(statusOf(loading, 'z')).toBe('loading');
  expect(applyBatch(loading, [{ kind: 'status', path: 'z', status: 'idle' }]).folders.has('z')).toBe(false);
  const err = applyBatch(t, [{ kind: 'status', path: 'a', status: 'error' }]);
  expect(statusOf(err, 'a')).toBe('error');
  expect(err.folders.get('a')!.children).toBe(t.folders.get('a')!.children);
  expect(applyBatch(t, [{ kind: 'status', path: 'a', status: 'loaded' }])).toBe(t);
});

test('sortedChildren returns the cached array until the node changes', () => {
  const t = sample();
  const a = t.folders.get('a')!;
  const first = sortedChildren(a, byName);
  expect(first.map((e) => e.path)).toEqual(['a/b', 'a/x.txt']);
  expect(sortedChildren(a, byName)).toBe(first);
  const desc = sortedChildren(a, { by: 'name', direction: 'desc' });
  expect(desc).not.toBe(first);
  expect(sortedChildren(a, byName)).toBe(first);
  const next = upsertEntry(t, file('a/0.txt')).folders.get('a')!;
  const after = sortedChildren(next, byName);
  expect(after).not.toBe(first);
  expect(after.map((e) => e.path)).toEqual(['a/b', 'a/0.txt', 'a/x.txt']);
});

test('sortedChildren of an edited folder, derived from its base order, equals a full sort under every sort spec', () => {
  const specs: SortSpec[] = ['name', 'extension', 'mtime', 'size'].flatMap((by) =>
    (['asc', 'desc'] as const).map((direction) => ({ by: by as SortSpec['by'], direction })),
  );
  const listed = Array.from({ length: 400 }, (_, i) =>
    i % 7 === 0
      ? dir(`big/d${i}`)
      : file(`big/f${i}.${['ts', 'md', 'txt'][i % 3]}`, { size: i % 13, mtimeMs: i % 17 }),
  );
  let tree = mergeListing(emptyTree(), '', 1, [dir('big')]);
  tree = mergeListing(tree, 'big', 1, listed);
  for (const spec of specs) sortedChildren(tree.folders.get('big')!, spec);
  for (let round = 0; round < 30; round++) {
    const victim = listed[(round * 37) % listed.length]!.path;
    tree = applyBatch(tree, [
      { kind: 'upsert', entry: file(`big/new-${round}.ts`, { size: round, mtimeMs: round }) },
      { kind: 'move', from: victim, to: `big/moved-${round}` },
      { kind: 'remove', path: `big/f${(round * 11) % 400}.md` },
      { kind: 'upsert', entry: file(`big/f${(round * 5) % 400}.txt`, { size: 99, mtimeMs: round }) },
    ]);
    const node = tree.folders.get('big')!;
    for (const spec of specs) {
      const fullSort = [...node.children.values()].sort((a, b) => compareEntries(a, b, spec));
      expect(sortedChildren(node, spec), `${spec.by} ${spec.direction}, round ${round}`).toEqual(fullSort);
    }
  }
});

test('sortedChildren after a seeded random edit sequence, long enough to compact the overlay, equals a full sort', () => {
  let state = 7;
  const random = (): number => (state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0) / 2 ** 32;
  const specs: SortSpec[] = [
    byName,
    { by: 'size', direction: 'desc' },
    { by: 'extension', direction: 'asc' },
  ];
  const fileAt = (path: string): Entry =>
    file(path, { size: Math.floor(random() * 20), mtimeMs: Math.floor(random() * 50) });
  let tree = mergeListing(emptyTree(), '', 1, [dir('big')]);
  tree = mergeListing(
    tree,
    'big',
    1,
    Array.from({ length: 300 }, (_, i) => fileAt(`big/f${i}.${['ts', 'md'][i % 2]}`)),
  );
  const names = (): string[] => [...tree.folders.get('big')!.children.keys()];
  const pickName = (): string => names()[Math.floor(random() * names().length)]!;
  const randomOp = (round: number): TreeOp => {
    const roll = random();
    if (roll < 0.3) return { kind: 'upsert', entry: fileAt(`big/new${round}.txt`) };
    if (roll < 0.5) return { kind: 'upsert', entry: fileAt(`big/${pickName()}`) };
    if (roll < 0.65) return { kind: 'upsert', entry: dir(`big/${pickName()}`) };
    if (roll < 0.85) return { kind: 'move', from: `big/${pickName()}`, to: `big/moved${round}` };
    return { kind: 'remove', path: `big/${pickName()}` };
  };
  for (let round = 0; round < 700; round++) {
    tree = applyBatch(tree, [randomOp(round)]);
    const node = tree.folders.get('big')!;
    for (const spec of specs) {
      const fullSort = [...node.children.values()].sort((a, b) => compareEntries(a, b, spec));
      expect(sortedChildren(node, spec), `${spec.by} ${spec.direction}, round ${round}`).toEqual(fullSort);
    }
  }
});

test('a large folder edited many times stays consistent with a plain Map', () => {
  const n = 5000;
  let t = mergeListing(
    emptyTree(),
    '',
    1,
    Array.from({ length: n }, (_, i) => file(`f${i}`)),
  );
  const model = new Map(childPaths(t, '').map((p) => [p, true]));
  for (let round = 0; round < 40; round++) {
    const ops: TreeOp[] = [];
    for (let j = 0; j < 50; j++) {
      const i = (round * 131 + j * 17) % (n + 200);
      if (j % 3 === 0) {
        ops.push({ kind: 'remove', path: `f${i}` });
        model.delete(`f${i}`);
      } else if (j % 3 === 1) {
        ops.push({ kind: 'upsert', entry: file(`f${i}`) });
        model.set(`f${i}`, true);
      } else if (model.has(`f${i}`)) {
        ops.push({ kind: 'move', from: `f${i}`, to: `g${round}-${j}` });
        model.delete(`f${i}`);
        model.set(`g${round}-${j}`, true);
      }
    }
    t = applyBatch(t, ops);
  }
  const node = t.folders.get('')!;
  expect(node.children.size).toBe(model.size);
  expect(childPaths(t, '').sort()).toEqual([...model.keys()].sort());
  for (const p of model.keys()) expect(node.children.has(p)).toBe(true);
});
