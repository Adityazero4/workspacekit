import { expect, test } from 'vitest';
import { generateTree } from '../src/memory/generate';
import { basename, parentPath } from '../src/path';
import { emptyTree, flattenVisible, mergeListing, type SortSpec, type TreeData } from '../src/tree/model';
import type { Entry } from '../src/types';
import { perfBudgetScale } from '../../../test-support/perfBudgetScale';

const dir = (path: string): Entry => ({ path, name: basename(path), kind: 'directory' });
const file = (path: string): Entry => ({ path, name: basename(path), kind: 'file' });
const allEntries = (t: TreeData): Entry[] => [...t.folders.values()].flatMap((n) => [...n.children.values()]);

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BUDGET_MS = 150 * perfBudgetScale(Number(env.PERF_BUDGET_SCALE ?? 1));

// Wall-clock budget: median of 3 runs, so one run slowed by parallel test load does not fail it. PERF_BUDGET_SCALE
// and this machine's speed (perfBudgetScale) scale it; CI_SLOW=1 skips it.
test.skipIf(env.CI_SLOW)('flattenVisible handles 100k entries under 150ms', () => {
  const entries: Entry[] = [];
  const dirs = new Set<string>();
  for (const p of Object.keys(generateTree({ files: 100_000, depth: 4, breadth: 20 }))) {
    entries.push(file(p));
    for (let d = parentPath(p); d && !dirs.has(d); d = parentPath(d)) {
      dirs.add(d);
      entries.push(dir(d));
    }
  }
  const expanded = new Set(dirs);
  const sort: SortSpec = { by: 'name', direction: 'asc' };
  // JIT warm-up on a separate tree, so the timed calls below still sort every folder (cold sortedChildren cache)
  flattenVisible(mergeListing(emptyTree(), '', 10, entries), { root: '', expanded, sort });
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = mergeListing(emptyTree(), '', 10, entries); // a fresh tree per run keeps the sort cache cold
    expect(allEntries(t).length).toBe(entries.length);
    const start = performance.now();
    const rows = flattenVisible(t, { root: '', expanded, sort });
    ms.push(performance.now() - start);
    expect(rows.length).toBe(entries.length);
  }
  expect([...ms].sort((a, b) => a - b)[1], 'median of 3').toBeLessThan(BUDGET_MS);
});
