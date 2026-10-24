import { describe, expect, test } from 'vitest';
import { generateShape, type TreeShape } from '../src/memory/generate';
import { basename, parentPath } from '../src/path';
import {
  applyBatch,
  emptyTree,
  mergeListing,
  moveSubtree,
  removeSubtree,
  sortedChildren,
  type SortSpec,
  type TreeOp,
} from '../src/tree/model';
import { createVisibleRowIndex } from '../src/tree/visible';
import type { Entry } from '../src/types';

// Generous wall-clock budgets (Node 22). Each figure is the median of 3 runs. PERF_BUDGET_SCALE (CI sets 1.5) scales them;
// CI_SLOW=1 skips them.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const PERF_BUDGET_SCALE = Number(env.PERF_BUDGET_SCALE ?? 1);
const M = 1_000_000;
const TIMEOUT = 120_000; // building the 1M inputs dominates; the budgets are asserted separately

function entriesOf(shape: TreeShape, size: number): Entry[] {
  const files = Object.keys(generateShape(shape, size));
  const dirs = new Set<string>();
  for (const p of files) for (let d = parentPath(p); d && !dirs.has(d); d = parentPath(d)) dirs.add(d);
  return [
    ...[...dirs].map((p): Entry => ({ path: p, name: basename(p), kind: 'directory' })),
    ...files.map((p): Entry => ({ path: p, name: basename(p), kind: 'file', size: 1 })),
  ];
}

function median3(fn: () => unknown): number {
  const ms = [0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  });
  return ms.sort((a, b) => a - b)[1]!;
}

/** The first (cold) run and the median of 3, both asserted: a median alone can hide a slow first pass. */
function expectCold3(fn: () => unknown, budget: number, label: string): void {
  const ms = [0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  });
  expect(ms[0], `${label} (cold)`).toBeLessThanOrEqual(budget * PERF_BUDGET_SCALE);
  expect([...ms].sort((a, b) => a - b)[1], `${label} (median)`).toBeLessThanOrEqual(
    budget * PERF_BUDGET_SCALE,
  );
}

describe.skipIf(env.CI_SLOW)('tree model scale budgets', () => {
  test(
    '1M wide: initial merge, rename one leaf, 5k mixed ops in one batch',
    () => {
      const entries = entriesOf('wide', M);
      expect(
        median3(() => mergeListing(emptyTree(), '', 100, entries)),
        'initial merge',
      ).toBeLessThanOrEqual(1500 * PERF_BUDGET_SCALE);
      const base = mergeListing(emptyTree(), '', 100, entries);
      const files = entries.filter((e) => e.kind === 'file');
      const leaf = files[0]!.path;
      expect(
        median3(() => moveSubtree(base, leaf, 'wide/renamed.txt')),
        'rename one leaf',
      ).toBeLessThanOrEqual(20 * PERF_BUDGET_SCALE);
      const ops: TreeOp[] = [];
      for (let i = 0; i < 1250; i++) {
        ops.push({
          kind: 'upsert',
          entry: { path: `wide/new-${i}.txt`, name: `new-${i}.txt`, kind: 'file', size: 1 },
        });
        ops.push({ kind: 'upsert', entry: { ...files[1250 + i * 7]!, size: 2 } });
        ops.push({ kind: 'remove', path: files[20_000 + i * 11]!.path });
        ops.push({ kind: 'move', from: files[40_000 + i * 13]!.path, to: `wide/renamed-${i}.txt` });
      }
      expect(
        median3(() => applyBatch(base, ops)),
        'applyBatch 5k mixed ops',
      ).toBeLessThanOrEqual(60 * PERF_BUDGET_SCALE);
      expect(applyBatch(base, ops).folders.get('wide')!.children.size).toBe(M); // +1250 created, -1250 removed
    },
    TIMEOUT,
  );

  test(
    '10x100k: expand one folder, rename a folder with 100k loaded descendants, delete a leaf',
    () => {
      const entries = entriesOf('10x100k', M);
      const shallow = mergeListing(emptyTree(), '', 1, entries);
      const listing = entries.filter((e) => parentPath(e.path) === 'd0');
      expect(listing.length).toBe(100_000);
      expect(
        median3(() => mergeListing(shallow, 'd0', 1, listing)),
        'expand (merge 100k listing)',
      ).toBeLessThanOrEqual(150 * PERF_BUDGET_SCALE);
      const base = mergeListing(emptyTree(), '', 100, entries);
      const renamed = moveSubtree(base, 'd0', 'renamed');
      expect(renamed.folders.get('renamed')!.children.size).toBe(100_000);
      expect(
        median3(() => moveSubtree(base, 'd0', 'renamed')),
        'rename folder with 100k descendants',
      ).toBeLessThanOrEqual(250 * PERF_BUDGET_SCALE);
      expect(
        median3(() => removeSubtree(base, listing[500]!.path)),
        'delete a leaf',
      ).toBeLessThanOrEqual(10 * PERF_BUDGET_SCALE);
    },
    TIMEOUT,
  );

  test(
    '1M chains64: initial merge, expand a deep folder',
    () => {
      const entries = entriesOf('chains64', M);
      expect(
        median3(() => mergeListing(emptyTree(), '', 100, entries)),
        'initial merge',
      ).toBeLessThanOrEqual(1500 * PERF_BUDGET_SCALE);
      // every folder down to the chain ends is loaded; the chain ends themselves (depth 64) are not
      const base = mergeListing(emptyTree(), '', 64, entries);
      const deep = entries.find((e) => e.kind === 'file' && e.path.startsWith('c500/'))!;
      const folder = parentPath(deep.path);
      const listing = entries.filter((e) => parentPath(e.path) === folder);
      expect(listing.length).toBe(1000);
      expect(
        median3(() => mergeListing(base, folder, 1, listing)),
        'expand a deep folder',
      ).toBeLessThanOrEqual(5 * PERF_BUDGET_SCALE);
    },
    TIMEOUT,
  );

  test(
    'chains64 at ~1M folders: dropping one dir, reached through its parent or detached below it',
    () => {
      const D = 64;
      const dirE = (p: string): Entry => ({ path: p, name: basename(p), kind: 'directory' });
      const entries: Entry[] = [dirE('z'), dirE('z/gone'), { path: 'z/gone/f', name: 'f', kind: 'file' }];
      for (let c = 0; c < 15_000; c++) {
        let p = `c${c}`;
        entries.push(dirE(p));
        for (let d = 1; d < D; d++) entries.push(dirE((p = `${p}/n${d}`)));
      }
      const loaded = mergeListing(emptyTree(), '', D + 1, entries);
      expect(loaded.folders.size).toBeGreaterThan(950_000);
      const detached = mergeListing(loaded, 'z/gone/q/r', 1, []); // opened from search: only a key scan finds it
      for (const [name, t] of [
        ['connected', loaded],
        ['detached', detached],
      ] as const) {
        const base = { folders: new Map(t.folders) }; // every node in a plain shared base map
        expect(
          median3(() => mergeListing(base, 'z', 1, [])),
          `${name} single-dir drop`,
        ).toBeLessThanOrEqual(100 * PERF_BUDGET_SCALE);
        expect([...mergeListing(base, 'z', 1, []).folders.keys()].filter((k) => k.startsWith('z'))).toEqual([
          'z',
        ]);
      }
    },
    TIMEOUT,
  );

  test(
    'root relist dropping 10k loaded folders',
    () => {
      const N = 10_000;
      const dirs = Array.from({ length: N }, (_, i): Entry => ({
        path: `d${i}`,
        name: `d${i}`,
        kind: 'directory',
      }));
      const ops: TreeOp[] = dirs.map((d) => ({
        kind: 'listing',
        folder: d.path,
        depth: 1,
        entries: [{ path: `${d.path}/f`, name: 'f', kind: 'file' }],
      }));
      const loaded = applyBatch(mergeListing(emptyTree(), '', 1, dirs), ops);
      const base = { folders: new Map(loaded.folders) }; // every node in a plain shared base map
      expect(
        median3(() => mergeListing(base, '', 1, [])),
        'relist dropping 10k loaded folders',
      ).toBeLessThanOrEqual(50 * PERF_BUDGET_SCALE);
      expect([...mergeListing(base, '', 1, []).folders.keys()]).toEqual(['']);
    },
    TIMEOUT,
  );

  describe('visible-row index', () => {
    const sort: SortSpec = { by: 'name', direction: 'asc' };
    const dirsOf = (entries: Entry[]): Set<string> =>
      new Set(entries.filter((e) => e.kind === 'directory').map((e) => e.path));

    test(
      '1M wide, all expanded: build, 10k rowAt',
      () => {
        const tree = mergeListing(emptyTree(), '', 100, entriesOf('wide', M));
        const opts = { root: '', expanded: new Set(['wide']), sort };
        expectCold3(() => createVisibleRowIndex(tree, opts), 80, 'build');
        // the one-time 1M sort is sortedChildren's (memoized per children map, shared with flattenVisible), not the index's
        sortedChildren(tree.folders.get('wide')!, sort);
        const idx = createVisibleRowIndex(tree, opts);
        expect(idx.count).toBe(M + 1);
        expectCold3(
          () => {
            for (let i = 0; i < 10_000; i++) idx.rowAt(i * 100);
          },
          20,
          '10k rowAt',
        );
      },
      TIMEOUT,
    );

    test(
      '10x100k, all expanded: collapse one folder (rebuild from prev)',
      () => {
        const tree = mergeListing(emptyTree(), '', 100, entriesOf('10x100k', M));
        const expanded = dirsOf(entriesOf('10x100k', 10));
        expect(expanded.size).toBe(10);
        const prev = createVisibleRowIndex(tree, { root: '', expanded, sort });
        prev.rowAt(0); // lay out the root, as a rendered list would have
        const collapsed = new Set([...expanded].filter((p) => p !== 'd0'));
        expectCold3(
          () => createVisibleRowIndex(tree, { root: '', expanded: collapsed, sort }, prev),
          5,
          'collapse',
        );
        const idx = createVisibleRowIndex(tree, { root: '', expanded: collapsed, sort }, prev);
        expect(idx.count).toBe(10 + 9 * 100_000);
        expect(idx.indexOf('d1')).toBe(1);
      },
      TIMEOUT,
    );

    test(
      '1M chains64, all expanded: build',
      () => {
        const entries = entriesOf('chains64', M);
        const tree = mergeListing(emptyTree(), '', 100, entries);
        const opts = { root: '', expanded: dirsOf(entries), sort };
        expectCold3(() => createVisibleRowIndex(tree, opts), 80, 'build');
        expect(createVisibleRowIndex(tree, opts).count).toBe(entries.length);
      },
      TIMEOUT,
    );
  });
});
