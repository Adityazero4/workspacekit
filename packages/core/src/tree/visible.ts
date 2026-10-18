import { basename, isSameOrDescendant, parentPath } from '../path';
import type { Entry } from '../types';
import { compareEntries, sortedChildren, statusOf, type FolderNode, type SortSpec, type TreeData, type VisibleRow } from './model';

/** Random access to the rows `flattenVisible` would produce, without materializing them. */
export interface VisibleRowIndex {
  readonly count: number;
  /** O(depth × log open siblings) once each folder on the way has been laid out. Throws `RangeError` outside `0..count-1`. */
  rowAt(index: number): VisibleRow;
  /** -1 when not visible (collapsed ancestor or not loaded), and for the root itself. */
  indexOf(path: string): number;
  /** Sticky headers: the open ancestor rows of the row at `index`, outermost first (not the row itself). Throws `RangeError` like `rowAt`. */
  ancestorsAt(index: number): readonly VisibleRow[];
}

/**
 * An open folder: the root, or an expanded directory listed by an open parent. Shared between indexes while its node,
 * its open children and the sort are unchanged, so a later index reuses its count and layout.
 */
interface Rec {
  readonly path: string;
  readonly node: FolderNode | undefined;
  /** Open child folders, unordered. */
  readonly kids: readonly Rec[];
  /** Visible rows below this folder. */
  readonly count: number;
  /** Built on first lookup; depends only on `node`, `kids` and the sort. */
  lay?: Layout;
}

interface Layout {
  sorted: readonly Entry[];
  /** Sorted index of each open child, ascending. */
  pos: number[];
  kids: Rec[];
  /** `before[j]`: rows inside the open children before `kids[j]` (length `kids.length + 1`). */
  before: number[];
}

/** Index of `e` in `sorted` (which holds `e`): binary search with the sort's own comparator. */
function indexIn(sorted: readonly Entry[], e: Entry, sort: SortSpec): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEntries(sorted[mid]!, e, sort) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Count of `xs` entries below `v` (`xs` ascending). */
function lowerBound(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class Index implements VisibleRowIndex {
  readonly count: number;
  constructor(
    readonly tree: TreeData,
    readonly expanded: ReadonlySet<string>,
    readonly sort: SortSpec,
    readonly sortKey: string,
    readonly recs: ReadonlyMap<string, Rec>,
    readonly root: Rec,
  ) {
    this.count = root.count;
  }

  #layout(rec: Rec): Layout {
    if (rec.lay) return rec.lay;
    const sorted = sortedChildren(rec.node!, this.sort);
    const at = rec.kids.map((k): [number, Rec] => [indexIn(sorted, rec.node!.children.get(basename(k.path))!, this.sort), k]);
    at.sort((x, y) => x[0] - y[0]);
    const before = [0];
    for (const [, k] of at) before.push(before[before.length - 1]! + k.count);
    return (rec.lay = { sorted, pos: at.map((x) => x[0]), kids: at.map((x) => x[1]), before });
  }

  #row(sorted: readonly Entry[], s: number, parent: string, depth: number): VisibleRow {
    const entry = sorted[s]!;
    return {
      path: entry.path,
      entry,
      depth,
      parentPath: parent,
      isExpanded: entry.kind === 'directory' && this.expanded.has(entry.path),
      status: statusOf(this.tree, entry.path),
      posInSet: s + 1,
      setSize: sorted.length,
    };
  }

  #descend(i: number, trail?: VisibleRow[]): VisibleRow {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) throw new RangeError(`row ${i} is outside 0..${this.count - 1}`);
    for (let rec = this.root, depth = 0; ; depth++) {
      const { sorted, pos, kids, before } = this.#layout(rec);
      let lo = 0; // open children starting at or before row i
      let hi = kids.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (pos[mid]! + before[mid]! <= i) lo = mid + 1;
        else hi = mid;
      }
      const j = lo - 1;
      const inside = j < 0 ? -1 : i - (pos[j]! + before[j]!) - 1; // row offset within open child j
      if (inside >= 0 && inside < kids[j]!.count) {
        trail?.push(this.#row(sorted, pos[j]!, rec.path, depth));
        rec = kids[j]!;
        i = inside;
        continue;
      }
      return this.#row(sorted, inside === -1 ? i - before[Math.max(j, 0)]! : i - before[lo]!, rec.path, depth);
    }
  }

  rowAt(index: number): VisibleRow {
    return this.#descend(index);
  }

  ancestorsAt(index: number): readonly VisibleRow[] {
    const trail: VisibleRow[] = [];
    this.#descend(index, trail);
    return trail;
  }

  indexOf(path: string): number {
    const top = this.root.path;
    if (path === top || !isSameOrDescendant(path, top)) return -1;
    let rec: Rec | undefined = this.root;
    let idx = 0;
    for (let from = top === '' ? 0 : top.length + 1; rec; ) {
      const cut = path.indexOf('/', from);
      const child = cut === -1 ? path : path.slice(0, cut);
      const e = rec.node?.children.get(child.slice(from));
      if (!e) return -1;
      const { sorted, pos, kids, before } = this.#layout(rec);
      const s = indexIn(sorted, e, this.sort);
      const k = lowerBound(pos, s);
      idx += s + before[k]!;
      if (cut === -1) return idx;
      rec = pos[k] === s ? kids[k] : undefined;
      idx++;
      from = cut + 1;
    }
    return -1;
  }
}

/**
 * The rendering path for the tree: a virtualized list asks for `count`, `rowAt(i)` for the rows on screen, `indexOf`
 * to scroll to a path, and `ancestorsAt` for sticky headers. Rows equal `flattenVisible(tree, opts)` (kept as the
 * reference and for small consumers) without building that list.
 *
 * A build visits only open folders (the root and expanded, listed directories below open parents), reading child
 * counts from node sizes; nothing is sorted until a lookup needs a folder's order. Pass the previous index as `prev`
 * after an expand, collapse or tree change: a folder whose node, open children and sort are unchanged keeps its
 * memoized counts and layout.
 *
 * @example
 * let index = createVisibleRowIndex(tree, { root: '', expanded, sort: { by: 'name', direction: 'asc' } });
 * const onScreen = Array.from({ length: 30 }, (_, k) => index.rowAt(first + k)); // first + 30 <= index.count
 * const sticky = index.ancestorsAt(first);
 * index = createVisibleRowIndex(nextTree, { root: '', expanded: nextExpanded, sort }, index); // reuses unchanged folders
 * scrollTo(index.indexOf('src/app/main.ts')); // -1 when hidden
 */
export function createVisibleRowIndex(
  tree: TreeData,
  opts: { root: string; expanded: ReadonlySet<string>; sort: SortSpec },
  prev?: VisibleRowIndex,
): VisibleRowIndex {
  const sortKey = `${opts.sort.by}:${opts.sort.direction}`;
  const old = prev instanceof Index && prev.sortKey === sortKey ? prev.recs : undefined;
  const openBelow = new Map<string, string[]>(); // folder -> expanded paths directly below it
  for (const p of opts.expanded) {
    if (p === '') continue;
    const q = parentPath(p);
    const list = openBelow.get(q);
    if (list) list.push(p);
    else openBelow.set(q, [p]);
  }
  const recs = new Map<string, Rec>();
  // ponytail: recursion depth = folder depth; make it iterative if trees get thousands of levels deep
  // ponytail: a rebuild from `prev` still walks every open folder (~35-42 ms with 64k open on 1M chains64); diff `expanded` and dirty paths against `prev` if that gets hot
  const build = (path: string): Rec => {
    const node = tree.folders.get(path);
    const kids: Rec[] = [];
    let count = node?.children.size ?? 0;
    if (node) {
      for (const p of openBelow.get(path) ?? []) {
        if (node.children.get(basename(p))?.kind !== 'directory') continue;
        const k = build(p);
        kids.push(k);
        count += k.count;
      }
    }
    // every old rec below `was` was reached through it, so equal length + all kids reused means the same open set
    const was = old?.get(path);
    const rec = was && was.node === node && was.kids.length === kids.length && kids.every((k) => old!.get(k.path) === k) ? was : { path, node, kids, count };
    recs.set(path, rec);
    return rec;
  };
  const root = build(opts.root);
  return new Index(tree, opts.expanded, opts.sort, sortKey, recs, root);
}
