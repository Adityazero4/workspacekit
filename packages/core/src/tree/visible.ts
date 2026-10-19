import { basename, isSameOrDescendant, parentPath } from '../path';
import type { Entry } from '../types';
import {
  compareEntries,
  sortedChildren,
  statusOf,
  type FolderNode,
  type SortSpec,
  type TreeData,
  type VisibleRow,
} from './model';

/**
 * Random access to the rows `flattenVisible` would produce, without materializing them.
 *
 * @example
 * ```ts
 * const firstVisible = index.count > 0 ? index.rowAt(0) : undefined;
 * ```
 */
export interface VisibleRowIndex {
  readonly count: number;
  /**
   * O(depth × log open siblings) once each folder on the way has been laid out. Throws `RangeError` outside
   * `0..count-1`.
   */
  rowAt(index: number): VisibleRow;
  /** -1 when not visible (collapsed ancestor or not loaded), and for the root itself. */
  indexOf(path: string): number;
  /**
   * Sticky headers: the open ancestor rows of the row at `index`, outermost first (not the row itself).
   * Throws `RangeError` like `rowAt`.
   */
  ancestorsAt(index: number): readonly VisibleRow[];
}

type HidePredicate = (entry: Entry) => boolean;

interface OpenFolder {
  readonly path: string;
  readonly node: FolderNode | undefined;
  readonly openChildren: readonly OpenFolder[];
  readonly rowCount: number;
  layout?: OpenFolderLayout;
}

interface OpenFolderLayout {
  visibleChildren: readonly Entry[];
  openChildPositions: number[];
  openChildrenInOrder: OpenFolder[];
  rowsInOpenChildrenBefore: number[];
}

function sortedIndexOf(sorted: readonly Entry[], entry: Entry, sort: SortSpec): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareEntries(sorted[middle]!, entry, sort) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function countBelow(ascending: readonly number[], value: number): number {
  let low = 0;
  let high = ascending.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ascending[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

const unhiddenCache = new WeakMap<readonly Entry[], WeakMap<HidePredicate, readonly Entry[]>>();
function unhidden(sorted: readonly Entry[], hide: HidePredicate | undefined): readonly Entry[] {
  if (!hide) return sorted;
  let perPredicate = unhiddenCache.get(sorted);
  if (!perPredicate) unhiddenCache.set(sorted, (perPredicate = new WeakMap()));
  let visible = perPredicate.get(hide);
  if (!visible) perPredicate.set(hide, (visible = sorted.filter((entry) => !hide(entry))));
  return visible;
}

const unhiddenCountCache = new WeakMap<ReadonlyMap<string, Entry>, WeakMap<HidePredicate, number>>();
function unhiddenCountWithoutSorting(node: FolderNode, hide: HidePredicate | undefined): number {
  if (!hide) return node.children.size;
  let perPredicate = unhiddenCountCache.get(node.children);
  if (!perPredicate) unhiddenCountCache.set(node.children, (perPredicate = new WeakMap()));
  let count = perPredicate.get(hide);
  if (count === undefined) {
    count = 0;
    for (const entry of node.children.values()) if (!hide(entry)) count++;
    perPredicate.set(hide, count);
  }
  return count;
}

const rowOfOpenChild = (layout: OpenFolderLayout, child: number): number =>
  layout.openChildPositions[child]! + layout.rowsInOpenChildrenBefore[child]!;

function openChildrenStartingAtOrBefore(layout: OpenFolderLayout, row: number): number {
  let low = 0;
  let high = layout.openChildrenInOrder.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rowOfOpenChild(layout, middle) <= row) low = middle + 1;
    else high = middle;
  }
  return low;
}

class RowIndex implements VisibleRowIndex {
  readonly count: number;
  constructor(
    readonly tree: TreeData,
    readonly expanded: ReadonlySet<string>,
    readonly sort: SortSpec,
    readonly sortKey: string,
    readonly hide: HidePredicate | undefined,
    readonly openFolders: ReadonlyMap<string, OpenFolder>,
    readonly root: OpenFolder,
  ) {
    this.count = root.rowCount;
  }

  #layout(folder: OpenFolder): OpenFolderLayout {
    if (folder.layout) return folder.layout;
    const visibleChildren = unhidden(sortedChildren(folder.node!, this.sort), this.hide);
    const positioned = folder.openChildren.map((child): [number, OpenFolder] => {
      const entry = folder.node!.children.get(basename(child.path))!;
      return [sortedIndexOf(visibleChildren, entry, this.sort), child];
    });
    positioned.sort((a, b) => a[0] - b[0]);
    const rowsInOpenChildrenBefore = [0];
    for (const [, child] of positioned) {
      rowsInOpenChildrenBefore.push(
        rowsInOpenChildrenBefore[rowsInOpenChildrenBefore.length - 1]! + child.rowCount,
      );
    }
    return (folder.layout = {
      visibleChildren,
      openChildPositions: positioned.map(([position]) => position),
      openChildrenInOrder: positioned.map(([, child]) => child),
      rowsInOpenChildrenBefore,
    });
  }

  #rowFor(siblings: readonly Entry[], position: number, parent: string, depth: number): VisibleRow {
    const entry = siblings[position]!;
    return {
      path: entry.path,
      entry,
      depth,
      parentPath: parent,
      isExpanded: entry.kind === 'directory' && this.expanded.has(entry.path),
      status: statusOf(this.tree, entry.path),
      posInSet: position + 1,
      setSize: siblings.length,
    };
  }

  #descendTo(index: number, ancestors?: VisibleRow[]): VisibleRow {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError(`row ${index} is outside 0..${this.count - 1}`);
    }
    let row = index;
    for (let folder = this.root, depth = 0; ; depth++) {
      const layout = this.#layout(folder);
      const startedBefore = openChildrenStartingAtOrBefore(layout, row);
      const lastStarted = startedBefore - 1;
      const offsetInsideChild = lastStarted < 0 ? -1 : row - rowOfOpenChild(layout, lastStarted) - 1;
      if (offsetInsideChild >= 0 && offsetInsideChild < layout.openChildrenInOrder[lastStarted]!.rowCount) {
        const childPosition = layout.openChildPositions[lastStarted]!;
        ancestors?.push(this.#rowFor(layout.visibleChildren, childPosition, folder.path, depth));
        folder = layout.openChildrenInOrder[lastStarted]!;
        row = offsetInsideChild;
        continue;
      }
      const rowsInChildrenBefore =
        offsetInsideChild === -1
          ? layout.rowsInOpenChildrenBefore[Math.max(lastStarted, 0)]!
          : layout.rowsInOpenChildrenBefore[startedBefore]!;
      return this.#rowFor(layout.visibleChildren, row - rowsInChildrenBefore, folder.path, depth);
    }
  }

  rowAt(index: number): VisibleRow {
    return this.#descendTo(index);
  }

  ancestorsAt(index: number): readonly VisibleRow[] {
    const ancestors: VisibleRow[] = [];
    this.#descendTo(index, ancestors);
    return ancestors;
  }

  indexOf(path: string): number {
    const rootPath = this.root.path;
    if (path === rootPath || !isSameOrDescendant(path, rootPath)) return -1;
    let folder: OpenFolder | undefined = this.root;
    let index = 0;
    for (let segmentStart = rootPath === '' ? 0 : rootPath.length + 1; folder;) {
      const segmentEnd = path.indexOf('/', segmentStart);
      const ancestorOrSelf = segmentEnd === -1 ? path : path.slice(0, segmentEnd);
      const entry = folder.node?.children.get(ancestorOrSelf.slice(segmentStart));
      if (!entry || this.hide?.(entry)) return -1;
      const layout = this.#layout(folder);
      const position = sortedIndexOf(layout.visibleChildren, entry, this.sort);
      const openChildrenBefore = countBelow(layout.openChildPositions, position);
      index += position + layout.rowsInOpenChildrenBefore[openChildrenBefore]!;
      if (segmentEnd === -1) return index;
      const isOpen = layout.openChildPositions[openChildrenBefore] === position;
      folder = isOpen ? layout.openChildrenInOrder[openChildrenBefore] : undefined;
      index++;
      segmentStart = segmentEnd + 1;
    }
    return -1;
  }
}

function expandedPathsByParent(expanded: ReadonlySet<string>): Map<string, string[]> {
  const byParent = new Map<string, string[]>();
  for (const path of expanded) {
    if (path === '') continue;
    const parent = parentPath(path);
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(path);
    else byParent.set(parent, [path]);
  }
  return byParent;
}

function isUnchangedOpenFolder(
  previous: OpenFolder | undefined,
  node: FolderNode | undefined,
  openChildren: readonly OpenFolder[],
  previousFolders: ReadonlyMap<string, OpenFolder> | undefined,
): previous is OpenFolder {
  return (
    previous !== undefined &&
    previous.node === node &&
    previous.openChildren.length === openChildren.length &&
    openChildren.every((child) => previousFolders?.get(child.path) === child)
  );
}

function collectOpenFolders(
  tree: TreeData,
  rootPath: string,
  expanded: ReadonlySet<string>,
  hide: HidePredicate | undefined,
  previousFolders: ReadonlyMap<string, OpenFolder> | undefined,
): { root: OpenFolder; openFolders: Map<string, OpenFolder> } {
  const expandedByParent = expandedPathsByParent(expanded);
  const openFolders = new Map<string, OpenFolder>();
  const openFolderAt = (path: string): OpenFolder => {
    const node = tree.folders.get(path);
    const openChildren: OpenFolder[] = [];
    let rowCount = node ? unhiddenCountWithoutSorting(node, hide) : 0;
    for (const childPath of node ? (expandedByParent.get(path) ?? []) : []) {
      const entry = node!.children.get(basename(childPath));
      if (entry?.kind !== 'directory' || hide?.(entry)) continue;
      const child = openFolderAt(childPath);
      openChildren.push(child);
      rowCount += child.rowCount;
    }
    const previous = previousFolders?.get(path);
    const folder = isUnchangedOpenFolder(previous, node, openChildren, previousFolders)
      ? previous
      : { path, node, openChildren, rowCount };
    openFolders.set(path, folder);
    return folder;
  };
  return { root: openFolderAt(rootPath), openFolders };
}

/**
 * The rendering path for the tree: a virtualized list asks for `count`, `rowAt(i)` for the rows on screen,
 * `indexOf` to scroll to a path, and `ancestorsAt` for sticky headers. Rows equal `flattenVisible(tree,
 * opts)` (kept as the reference and for small consumers) without building that list.
 *
 * A build visits only open folders (the root and expanded, listed directories below open parents), reading
 * child counts from node sizes; nothing is sorted until a lookup needs a folder's order. Each open folder
 * then keeps the sorted positions of its open children and a running total of the rows inside them, so
 * `rowAt` and `indexOf` binary search one folder per level. Pass the previous index as `prev` after an
 * expand, collapse or tree change: a folder whose node, open children and sort are unchanged keeps its
 * memoized counts and layout.
 *
 * `hide` drops entries and their subtrees from every result (count, rows, `posInSet`/`setSize`, `indexOf`,
 * `ancestorsAt`). It must be pure, and its identity must stay stable while its answers do: results are
 * memoized per `hide` function, and a `prev` built with another `hide` is not reused.
 *
 * @example
 * ```ts
 * let index = createVisibleRowIndex(tree, { root: '', expanded, sort: { by: 'name', direction: 'asc' } });
 * const onScreen = Array.from({ length: 30 }, (_, k) => index.rowAt(first + k)); // first + 30 <= index.count
 * const sticky = index.ancestorsAt(first);
 * // reuses the layout of unchanged folders
 * index = createVisibleRowIndex(nextTree, { root: '', expanded: nextExpanded, sort }, index);
 * scrollTo(index.indexOf('src/app/main.ts')); // -1 when hidden
 * const noGit = createVisibleRowIndex(tree, { root: '', expanded, sort, hide: (e) => e.name === '.git' });
 * ```
 */
export function createVisibleRowIndex(
  tree: TreeData,
  opts: { root: string; expanded: ReadonlySet<string>; sort: SortSpec; hide?: (entry: Entry) => boolean },
  prev?: VisibleRowIndex,
): VisibleRowIndex {
  const { hide } = opts;
  const sortKey = `${opts.sort.by}:${opts.sort.direction}`;
  const prevBuiltWithSameOptions = prev instanceof RowIndex && prev.sortKey === sortKey && prev.hide === hide;
  const previousFolders = prevBuiltWithSameOptions ? prev.openFolders : undefined;
  const { root, openFolders } = collectOpenFolders(tree, opts.root, opts.expanded, hide, previousFolders);
  return new RowIndex(tree, opts.expanded, opts.sort, sortKey, hide, openFolders, root);
}
