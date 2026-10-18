import { expect, test } from 'vitest';
import { basename, parentPath } from '../src/path';
import { applyBatch, emptyTree, flattenVisible, mergeListing, type SortSpec, type TreeData, type TreeOp, type VisibleRow } from '../src/tree/model';
import { createVisibleRowIndex, type VisibleRowIndex } from '../src/tree/visible';
import type { Entry } from '../src/types';

const dir = (path: string): Entry => ({ path, name: basename(path), kind: 'directory' });
const file = (path: string): Entry => ({ path, name: basename(path), kind: 'file' });
const byName: SortSpec = { by: 'name', direction: 'asc' };
const SORTS: SortSpec[] = (['name', 'extension', 'mtime', 'size'] as const).flatMap((by) =>
  (['asc', 'desc'] as const).map((direction) => ({ by, direction })),
);
const rowsOf = (idx: VisibleRowIndex): VisibleRow[] => Array.from({ length: idx.count }, (_, i) => idx.rowAt(i));

function sample(): TreeData {
  let t = mergeListing(emptyTree(), '', 2, [dir('a'), dir('a/b'), file('a/x.txt'), file('top.md')]);
  t = mergeListing(t, 'a/b', 2, [dir('a/b/c'), file('a/b/c/d.txt'), file('a/b/e.txt')]);
  return t;
}

test('rowAt, indexOf and ancestorsAt on a small tree', () => {
  const t = sample();
  const idx = createVisibleRowIndex(t, { root: '', expanded: new Set(['a', 'a/b', 'a/b/c']), sort: byName });
  expect(rowsOf(idx).map((r) => r.path)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d.txt', 'a/b/e.txt', 'a/x.txt', 'top.md']);
  expect(idx.indexOf('a/b/e.txt')).toBe(4);
  expect(idx.indexOf('a/b/c/d.txt')).toBe(3);
  expect(idx.indexOf('')).toBe(-1);
  expect(idx.indexOf('a/nope')).toBe(-1);
  expect(idx.ancestorsAt(3).map((r) => r.path)).toEqual(['a', 'a/b', 'a/b/c']);
  expect(idx.ancestorsAt(1).map((r) => r.path)).toEqual(['a']); // a row is not its own ancestor
  expect(idx.ancestorsAt(6)).toEqual([]);
  expect(() => idx.rowAt(idx.count)).toThrow(RangeError);
  expect(() => idx.rowAt(-1)).toThrow(RangeError);
  expect(() => idx.ancestorsAt(idx.count)).toThrow(RangeError);

  const closed = createVisibleRowIndex(t, { root: '', expanded: new Set(['a/b']), sort: byName }); // a/b open under a closed a
  expect(rowsOf(closed).map((r) => r.path)).toEqual(['a', 'top.md']);
  expect(closed.indexOf('a/b')).toBe(-1);
  expect(closed.indexOf('a/b/e.txt')).toBe(-1);
});

test('expanded folders that are not loaded, loading or errored contribute zero rows but keep their status', () => {
  let t = mergeListing(emptyTree(), '', 1, [dir('a'), dir('b'), dir('c')]);
  t = applyBatch(t, [{ kind: 'status', path: 'b', status: 'loading' }, { kind: 'status', path: 'c', status: 'error' }]);
  const idx = createVisibleRowIndex(t, { root: '', expanded: new Set(['a', 'b', 'c']), sort: byName });
  expect(rowsOf(idx).map((r) => [r.path, r.isExpanded, r.status])).toEqual([
    ['a', true, 'idle'],
    ['b', true, 'loading'],
    ['c', true, 'error'],
  ]);
  expect(idx.indexOf('c')).toBe(2);
});

// Random trees from random op batches (detached nodes, stale listings, statuses), random expanded sets that include
// unloaded folders, files and missing paths, random roots, every sort spec; each index is built from the previous one.
test('random trees: rowAt matches flattenVisible, indexOf inverts it, ancestorsAt is the open chain', () => {
  let seed = 11; // mulberry32: every bit is usable, unlike a power-of-two LCG's low bits
  const rnd = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
  const NAMES = ['a', 'b', 'c.md', 'd.txt', 'e10', 'e9', 'F.ts'];
  const rp = (max: number): string => Array.from({ length: 1 + rnd(max) }, () => NAMES[rnd(NAMES.length)]).join('/');
  const ent = (path: string, kind: Entry['kind']): Entry => ({ path, name: basename(path), kind, mtimeMs: rnd(3), size: rnd(3) });
  let t = emptyTree();
  const pick = <T,>(xs: T[], fallback: () => T): T => (xs.length && rnd(5) ? xs[rnd(xs.length)]! : fallback());
  const dirs = (): string[] => [...t.folders.values()].flatMap((n) => [...n.children.values()].filter((e) => e.kind === 'directory').map((e) => e.path));
  const under = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name);
  const op = (): TreeOp => {
    const r = rnd(10);
    const any = (): string => pick([...t.folders.keys(), ...dirs()], () => rp(3));
    if (r < 5) {
      const folder = rnd(3) ? any() : '';
      const depth = 1 + rnd(3);
      const at = (q: string): string => (folder ? `${folder}/${q}` : q);
      const listed = new Map<string, Entry>();
      for (let n = rnd(10); n > 0; n--) {
        const q = rp(depth);
        listed.set(at(q), ent(at(q), rnd(3) ? 'directory' : 'file'));
        for (let a = parentPath(q); a !== ''; a = parentPath(a)) listed.set(at(a), ent(at(a), 'directory'));
      }
      return { kind: 'listing', folder, depth, entries: [...listed.values()] };
    }
    if (r < 7) return { kind: 'status', path: any(), status: (['loading', 'loaded', 'error', 'idle'] as const)[rnd(4)]! };
    if (r < 8) return { kind: 'upsert', entry: ent(rnd(2) ? under(any(), rp(1)) : rp(3), rnd(2) ? 'directory' : 'file') };
    if (r < 9) return { kind: 'remove', path: any() };
    return { kind: 'move', from: any(), to: rp(2) };
  };

  let expanded = new Set<string>();
  let prev: VisibleRowIndex | undefined;
  const sortsSeen = new Set<string>();
  for (let step = 0; step < 3000; step++) {
    if (rnd(200) === 0) t = emptyTree();
    if (rnd(2)) t = applyBatch(t, Array.from({ length: 1 + rnd(3) }, op));
    if (rnd(2)) {
      const candidates = [...dirs(), ...t.folders.keys()].filter((k) => k !== '');
      expanded = new Set(expanded);
      for (let n = rnd(6); n > 0; n--) {
        const p = pick(candidates, () => rp(3));
        if (expanded.has(p)) expanded.delete(p);
        else if (rnd(2)) expanded.add(p);
        else for (let q = p; q !== ''; q = parentPath(q)) expanded.add(q); // reveal: open the whole chain
      }
    }
    const root = rnd(6) ? '' : rp(2);
    const sort = rnd(4) ? byName : SORTS[rnd(SORTS.length)]!;
    sortsSeen.add(`${sort.by}:${sort.direction}`);
    const opts = { root, expanded, sort };
    const idx = createVisibleRowIndex(t, opts, rnd(5) ? prev : undefined);
    prev = idx;

    const flat = flattenVisible(t, opts);
    expect(idx.count).toBe(flat.length);
    expect(rowsOf(idx)).toEqual(flat);
    const at = new Map(flat.map((r, i) => [r.path, i]));
    const candidates = [root, rp(3), ...[...t.folders.values()].flatMap((n) => [n.path, ...[...n.children.values()].map((e) => e.path)])];
    for (const p of candidates) expect(idx.indexOf(p)).toBe(at.get(p) ?? -1);
    flat.forEach((r, i) => {
      const chain: VisibleRow[] = [];
      for (let q = r.parentPath; q !== root; q = parentPath(q)) chain.unshift(flat[at.get(q)!]!);
      expect(idx.ancestorsAt(i)).toEqual(chain);
    });
  }
  expect(sortsSeen.size).toBe(SORTS.length);
});
