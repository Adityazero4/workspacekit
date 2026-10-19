import { basename, extname, isSameOrDescendant, parentPath } from '../path';
import type { Entry } from '../types';

/**
 * Load state of one folder: never requested, being fetched, listed, or failed.
 *
 * @example
 * ```ts
 * const isBusy = statusOf(tree, 'src') === 'loading';
 * ```
 */
export type FolderStatus = 'idle' | 'loading' | 'loaded' | 'error';
/**
 * One folder whose children are known (or being fetched). Immutable: a change makes a new node, so an
 * untouched node keeps its identity.
 *
 * @example
 * ```ts
 * const names = [...tree.folders.get('src')!.children.keys()];
 * ```
 */
export interface FolderNode {
  readonly path: string;
  /** Keyed by child name. */
  readonly children: ReadonlyMap<string, Entry>;
  readonly status: FolderStatus;
}
/**
 * Keyed by folder path (root `''`). A folder without a node is 'idle' and its children are unknown.
 *
 * @example
 * ```ts
 * const tree: TreeData = mergeListing(emptyTree(), '', 1, entries);
 * ```
 */
export interface TreeData {
  readonly folders: ReadonlyMap<string, FolderNode>;
}
/**
 * One change `applyBatch` applies to a tree.
 *
 * @example
 * ```ts
 * const op: TreeOp = { kind: 'move', from: 'a/old.ts', to: 'a/new.ts' };
 * ```
 */
export type TreeOp =
  | { kind: 'listing'; folder: string; depth: number; entries: Entry[] }
  | { kind: 'remove'; path: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'upsert'; entry: Entry }
  | { kind: 'status'; path: string; status: FolderStatus };
/**
 * How sibling entries are ordered. Folders always come first.
 *
 * @example
 * ```ts
 * const sort: SortSpec = { by: 'mtime', direction: 'desc' };
 * ```
 */
export interface SortSpec {
  by: 'name' | 'extension' | 'mtime' | 'size';
  direction: 'asc' | 'desc';
}
/**
 * One row of the flattened tree, with everything a renderer needs for ARIA attributes.
 *
 * @example
 * ```ts
 * const label = `${row.entry.name} (${row.posInSet} of ${row.setSize})`;
 * ```
 */
export interface VisibleRow {
  path: string;
  entry: Entry;
  depth: number;
  parentPath: string;
  isExpanded: boolean;
  status: FolderStatus;
  /** 1-based (aria-posinset) */
  posInSet: number;
  setSize: number;
}

const DELETED = null;
const maxOverlaySize = (baseSize: number): number => 64 + 8 * Math.sqrt(baseSize);

class CopyOnWriteMap<V> implements ReadonlyMap<string, V> {
  readonly #base: ReadonlyMap<string, V>;
  readonly #overlay: Map<string, V | typeof DELETED>;
  #size: number;
  constructor(
    base: ReadonlyMap<string, V> = new Map(),
    overlay: Map<string, V | typeof DELETED> = new Map(),
    size = base.size,
  ) {
    this.#base = base;
    this.#overlay = overlay;
    this.#size = size;
  }
  get base(): ReadonlyMap<string, V> {
    return this.#base;
  }
  get changesOverBase(): ReadonlyMap<string, V | typeof DELETED> {
    return this.#overlay;
  }
  static wrap<V>(map: ReadonlyMap<string, V>): CopyOnWriteMap<V> {
    return map instanceof CopyOnWriteMap ? (map as CopyOnWriteMap<V>) : new CopyOnWriteMap(map);
  }
  get size(): number {
    return this.#size;
  }
  get(key: string): V | undefined {
    const overlaid = this.#overlay.get(key);
    return overlaid === DELETED ? undefined : (overlaid ?? this.#base.get(key));
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  fork(): CopyOnWriteMap<V> {
    return new CopyOnWriteMap(this.#base, new Map(this.#overlay), this.#size);
  }
  compactIfOverlayOutgrown(): CopyOnWriteMap<V> {
    return this.#overlay.size > maxOverlaySize(this.#base.size) ? new CopyOnWriteMap(new Map(this)) : this;
  }
  set(key: string, value: V): void {
    if (!this.has(key)) this.#size++;
    this.#overlay.set(key, value);
  }
  delete(key: string): void {
    if (!this.has(key)) return;
    this.#size--;
    if (this.#base.has(key)) this.#overlay.set(key, DELETED);
    else this.#overlay.delete(key);
  }
  *#merged(): Generator<[string, V], undefined> {
    for (const pair of this.#base) if (!this.#overlay.has(pair[0])) yield pair;
    for (const [key, value] of this.#overlay) if (value !== DELETED) yield [key, value];
  }
  entries(): MapIterator<[string, V]> {
    return this.#overlay.size === 0 ? this.#base.entries() : this.#merged();
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
  *#mergedKeys(): Generator<string, undefined> {
    for (const [key] of this.#merged()) yield key;
  }
  *#mergedValues(): Generator<V, undefined> {
    for (const [, value] of this.#merged()) yield value;
  }
  keys(): MapIterator<string> {
    return this.#overlay.size === 0 ? this.#base.keys() : this.#mergedKeys();
  }
  values(): MapIterator<V> {
    return this.#overlay.size === 0 ? this.#base.values() : this.#mergedValues();
  }
  forEach(callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

interface DraftFolder {
  path: string;
  children: CopyOnWriteMap<Entry>;
  status: FolderStatus;
}

function isDetached(folders: ReadonlyMap<string, FolderNode>, path: string): boolean {
  return path !== '' && folders.get(parentPath(path))?.children.get(basename(path))?.kind !== 'directory';
}

const detachedPathsCache = new WeakMap<ReadonlyMap<string, FolderNode>, ReadonlySet<string>>();
function detachedPaths(folders: ReadonlyMap<string, FolderNode>): ReadonlySet<string> {
  let paths = detachedPathsCache.get(folders);
  if (!paths) {
    const found = new Set<string>();
    for (const path of folders.keys()) if (isDetached(folders, path)) found.add(path);
    detachedPathsCache.set(folders, (paths = found));
  }
  return paths;
}

function relativeDepthBelow(folder: string): (path: string) => number {
  const depthByPath = new Map<string, number>();
  const firstSeparatorSearchFrom = folder === '' ? 0 : folder.length + 1;
  return (path) => {
    let depth = depthByPath.get(path);
    if (depth === undefined) {
      if (path === folder) depth = 0;
      else if (folder !== '' && !path.startsWith(folder + '/')) depth = -1;
      else {
        depth = 1;
        for (
          let at = path.indexOf('/', firstSeparatorSearchFrom);
          at !== -1;
          at = path.indexOf('/', at + 1)
        ) {
          depth++;
        }
      }
      depthByPath.set(path, depth);
    }
    return depth;
  };
}

type ListedChildren = Map<string, Map<string, Entry>>;

function groupListedEntriesByParent(
  folder: string,
  depth: number,
  entries: Entry[],
  relativeDepth: (path: string) => number,
): ListedChildren {
  const childrenByParent: ListedChildren = new Map();
  for (const entry of entries) {
    if (entry.path === folder) continue;
    const parent = parentPath(entry.path);
    const entryDepth = relativeDepth(parent) + 1;
    if (entryDepth < 1 || entryDepth > depth) continue;
    let children = childrenByParent.get(parent);
    if (!children) childrenByParent.set(parent, (children = new Map<string, Entry>()));
    children.set(basename(entry.path), entry);
  }
  return childrenByParent;
}

function classifyListedDirectories(
  childrenByParent: ListedChildren,
  depth: number,
  relativeDepth: (path: string) => number,
): { listedInside: Set<string>; keptAtBoundary: Set<string> } {
  const listedInside = new Set<string>();
  const keptAtBoundary = new Set<string>();
  for (const [parent, children] of childrenByParent) {
    const childDepth = relativeDepth(parent) + 1;
    for (const entry of children.values()) {
      if (entry.kind !== 'directory') continue;
      if (childDepth < depth && entry.meta?.incomplete !== true) listedInside.add(entry.path);
      else keptAtBoundary.add(entry.path);
    }
  }
  return { listedInside, keptAtBoundary };
}

function isKeptByBoundaryAncestor(
  path: string,
  windowPrefix: string,
  depth: number,
  keptAtBoundary: Set<string>,
): boolean {
  for (let separator = windowPrefix.length - 1, level = 0; level < depth; level++) {
    separator = path.indexOf('/', separator + 1);
    if (keptAtBoundary.has(separator === -1 ? path : path.slice(0, separator))) return true;
    if (separator === -1) return false;
  }
  return false;
}

class TreeBatch {
  readonly #originalTree: TreeData;
  readonly #originalFolders: CopyOnWriteMap<FolderNode>;
  #batchCopy: CopyOnWriteMap<FolderNode> | undefined;
  readonly #ownedNodes = new Set<FolderNode>();
  readonly #detachedWhenPut: string[] = [];
  #ancestorsOfDetached: Set<string> | undefined;

  constructor(tree: TreeData) {
    this.#originalTree = tree;
    this.#originalFolders = CopyOnWriteMap.wrap(tree.folders);
  }

  apply(op: TreeOp): void {
    switch (op.kind) {
      case 'listing':
        return this.#listing(op.folder, op.depth, op.entries);
      case 'remove':
        return this.#remove(op.path);
      case 'move':
        return this.#move(op.from, op.to);
      case 'upsert':
        return this.#upsert(op.entry);
      case 'status':
        return this.#setStatus(op.path, op.status);
    }
  }

  finish(): TreeData {
    if (!this.#batchCopy) return this.#originalTree;
    for (const node of this.#ownedNodes) {
      const draft = node as DraftFolder;
      draft.children = draft.children.compactIfOverlayOutgrown();
    }
    const folders = this.#batchCopy.compactIfOverlayOutgrown();
    if (this.#ancestorsOfDetached || detachedPathsCache.has(this.#originalTree.folders)) {
      const stillDetached = new Set<string>();
      for (const path of [...detachedPaths(this.#originalTree.folders), ...this.#detachedWhenPut]) {
        if (folders.has(path) && isDetached(folders, path)) stillDetached.add(path);
      }
      detachedPathsCache.set(folders, stillDetached);
    }
    return { folders };
  }

  #current(): ReadonlyMap<string, FolderNode> {
    return this.#batchCopy ?? this.#originalTree.folders;
  }

  #batchCopyForWriting(): CopyOnWriteMap<FolderNode> {
    return (this.#batchCopy ??= this.#originalFolders.fork());
  }

  #entry(path: string): Entry | undefined {
    return entryAt({ folders: this.#current() }, path);
  }

  #addAncestorsOfDetached(path: string): void {
    for (let ancestor = path; ancestor !== '' && this.#ancestorsOfDetached;) {
      ancestor = parentPath(ancestor);
      if (this.#ancestorsOfDetached.has(ancestor)) break;
      this.#ancestorsOfDetached.add(ancestor);
    }
  }

  #trackIfDetached(path: string): void {
    if (!isDetached(this.#current(), path)) return;
    this.#detachedWhenPut.push(path);
    this.#addAncestorsOfDetached(path);
  }

  #mayHaveDetachedNodeBelow(path: string): boolean {
    if (!this.#ancestorsOfDetached) {
      this.#ancestorsOfDetached = new Set();
      for (const detached of detachedPaths(this.#originalTree.folders)) {
        this.#addAncestorsOfDetached(detached);
      }
      for (const detached of this.#detachedWhenPut) this.#addAncestorsOfDetached(detached);
    }
    return this.#ancestorsOfDetached.has(path);
  }

  #put(draft: DraftFolder, attachedByConstruction = false): void {
    this.#ownedNodes.add(draft);
    this.#batchCopyForWriting().set(draft.path, draft);
    if (!attachedByConstruction) this.#trackIfDetached(draft.path);
  }

  #ownFolder(path: string): DraftFolder {
    const current = this.#current().get(path);
    if (current && this.#ownedNodes.has(current)) return current as DraftFolder;
    const draft: DraftFolder = {
      path,
      children: current ? CopyOnWriteMap.wrap(current.children).fork() : new CopyOnWriteMap(),
      status: current?.status ?? 'idle',
    };
    this.#put(draft, current !== undefined);
    return draft;
  }

  #nodePathsAtOrBelow(path: string): string[] {
    if (!this.#current().has(path) && !this.#mayHaveDetachedNodeBelow(path)) return [];
    const paths: string[] = [];
    for (const nodePath of this.#current().keys()) {
      if (isSameOrDescendant(nodePath, path)) paths.push(nodePath);
    }
    return paths;
  }

  #remove(path: string): void {
    const entry = this.#entry(path);
    const nodePaths = this.#nodePathsAtOrBelow(path);
    if (entry) this.#ownFolder(parentPath(path)).children.delete(basename(path));
    for (const nodePath of nodePaths) this.#batchCopyForWriting().delete(nodePath);
  }

  #move(from: string, to: string): void {
    const isNoopOrIntoItself = from === '' || to === '' || isSameOrDescendant(to, from);
    if (isNoopOrIntoItself) return;
    const entry = this.#entry(from);
    const nodes = this.#nodePathsAtOrBelow(from).map((nodePath) => this.#current().get(nodePath)!);
    if (!entry && nodes.length === 0) return;
    if (entry) this.#ownFolder(parentPath(from)).children.delete(basename(from));
    for (const node of nodes) this.#batchCopyForWriting().delete(node.path);
    this.#remove(to);
    if (entry) {
      this.#ownFolder(parentPath(to)).children.set(basename(to), { ...entry, path: to, name: basename(to) });
    }
    for (const node of nodes) {
      const path = to + node.path.slice(from.length);
      const children = new Map<string, Entry>();
      for (const [name, child] of node.children) children.set(name, { ...child, path: `${path}/${name}` });
      this.#put({ path, children: new CopyOnWriteMap(children), status: node.status });
    }
  }

  #upsert(entry: Entry): void {
    if (entry.kind !== 'directory') {
      for (const nodePath of this.#nodePathsAtOrBelow(entry.path)) {
        this.#batchCopyForWriting().delete(nodePath);
      }
    }
    this.#ownFolder(parentPath(entry.path)).children.set(basename(entry.path), entry);
  }

  #setStatus(path: string, status: FolderStatus): void {
    const current = this.#current().get(path);
    if ((current?.status ?? 'idle') === status) return;
    if (status === 'idle' && current!.children.size === 0) {
      this.#batchCopyForWriting().delete(path);
      return;
    }
    const childrenSharedNotCopied = current?.children ?? new CopyOnWriteMap();
    this.#batchCopyForWriting().set(path, { path, children: childrenSharedNotCopied, status });
    if (!current) this.#trackIfDetached(path);
  }

  #listing(folder: string, depth: number, entries: Entry[]): void {
    const relativeDepth = relativeDepthBelow(folder);
    const childrenByParent = groupListedEntriesByParent(folder, depth, entries, relativeDepth);
    const { listedInside, keptAtBoundary } = classifyListedDirectories(
      childrenByParent,
      depth,
      relativeDepth,
    );
    this.#dropNodesReachableThroughOldListing(folder, keptAtBoundary);
    if (this.#mayHaveDetachedNodeBelow(folder)) {
      this.#dropDetachedNodesInWindow(folder, depth, keptAtBoundary);
    }
    this.#putListedFolders(folder, childrenByParent, listedInside);
  }

  #dropNodesReachableThroughOldListing(folder: string, keptAtBoundary: Set<string>): void {
    const oldNode = this.#current().get(folder);
    const stack: FolderNode[] = oldNode ? [oldNode] : [];
    for (let node = stack.pop(); node; node = stack.pop()) {
      for (const name of node.children.keys()) {
        const childPath = node.path === '' ? name : `${node.path}/${name}`;
        const child = this.#current().get(childPath);
        if (!child || keptAtBoundary.has(childPath)) continue;
        this.#batchCopyForWriting().delete(childPath);
        stack.push(child);
      }
    }
  }

  #dropDetachedNodesInWindow(folder: string, depth: number, keptAtBoundary: Set<string>): void {
    const windowPrefix = folder === '' ? '' : `${folder}/`;
    const dropped: string[] = [];
    for (const nodePath of this.#current().keys()) {
      if (nodePath === folder || !nodePath.startsWith(windowPrefix)) continue;
      if (!isKeptByBoundaryAncestor(nodePath, windowPrefix, depth, keptAtBoundary)) dropped.push(nodePath);
    }
    for (const nodePath of dropped) this.#batchCopyForWriting().delete(nodePath);
  }

  #putListedFolders(folder: string, childrenByParent: ListedChildren, listedInside: Set<string>): void {
    const loadedNode = (path: string): DraftFolder => ({
      path,
      children: new CopyOnWriteMap(childrenByParent.get(path) ?? new Map<string, Entry>()),
      status: 'loaded',
    });
    this.#put(loadedNode(folder));
    for (const [parent, children] of childrenByParent) {
      const parentNodeListsIt = parent === folder || listedInside.has(parent);
      for (const entry of children.values()) {
        if (listedInside.has(entry.path)) this.#put(loadedNode(entry.path), parentNodeListsIt);
      }
    }
  }
}

/**
 * A tree with no folders loaded.
 *
 * @example
 * ```ts
 * let tree = emptyTree();
 * ```
 */
export function emptyTree(): TreeData {
  return { folders: new CopyOnWriteMap() };
}

/**
 * The entry at `path`, if its parent folder is loaded; always `undefined` for the root.
 *
 * @example
 * ```ts
 * const entry = entryAt(tree, 'src/main.ts');
 * ```
 */
export function entryAt(tree: TreeData, path: string): Entry | undefined {
  return path === '' ? undefined : tree.folders.get(parentPath(path))?.children.get(basename(path));
}

/**
 * The load status of the folder at `path` (`'idle'` when it has no node).
 *
 * @example
 * ```ts
 * if (statusOf(tree, 'src') !== 'loaded') await store.loadFolder('src');
 * ```
 */
export function statusOf(tree: TreeData, path: string): FolderStatus {
  return tree.folders.get(path)?.status ?? 'idle';
}

/**
 * Applies `ops` in order and returns the new tree; `tree` itself is never changed. The outer map is copied at
 * most once and each touched folder once, so untouched nodes keep their identity.
 *
 * Folder maps are copy-on-write: a never-written base plus a private overlay. A fork costs O(overlay), not
 * O(size), and an overlay that outgrows 64 + 8·√size is folded into a fresh base, so a folder with 1M
 * children can change one child without copying the other 999,999.
 *
 * A node is detached when the walk from its parent cannot reach it: the parent has no node, or does not list
 * it as a directory (a folder opened from search, or under a stale listing). Detached paths are carried from
 * tree to tree, and their ancestors are indexed on first need. Deleting a node always deletes the nodes
 * attached below it, so any other node below a path has a detached ancestor-or-self there: removing, moving
 * or relisting a folder scans every loaded folder only when that index says a detached node may sit below it.
 *
 * A `listing` op replaces the `depth`-level window below `folder`. A deeper node survives only while its
 * ancestor at the window boundary is a listed directory. A directory marked `meta.incomplete` (the source did
 * not walk it) is treated like one at the boundary: the listing says nothing about its children, so it keeps
 * whatever node it had and is never marked 'loaded' by its parent's listing.
 *
 * @example
 * ```ts
 * const next = applyBatch(tree, [
 *   { kind: 'remove', path: 'src/old.ts' },
 *   { kind: 'upsert', entry: { path: 'src/new.ts', name: 'new.ts', kind: 'file' } },
 * ]);
 * ```
 */
export function applyBatch(tree: TreeData, ops: TreeOp[]): TreeData {
  const batch = new TreeBatch(tree);
  for (const op of ops) batch.apply(op);
  return batch.finish();
}

/**
 * `entries` are the descendants of `folder` down to `depth` relative levels. Everything in that window is
 * replaced; deeper entries survive only while their ancestor at relative depth `depth` still exists.
 *
 * @example
 * ```ts
 * tree = mergeListing(tree, 'src', 2, await adapter.list('src', { depth: 2 }));
 * ```
 */
export function mergeListing(tree: TreeData, folder: string, depth: number, entries: Entry[]): TreeData {
  return applyBatch(tree, [{ kind: 'listing', folder, depth, entries }]);
}

/**
 * Removes `path` and every loaded folder below it.
 *
 * @example
 * ```ts
 * tree = removeSubtree(tree, 'build');
 * ```
 */
export function removeSubtree(tree: TreeData, path: string): TreeData {
  return applyBatch(tree, [{ kind: 'remove', path }]);
}

/**
 * Moves `from` (and every loaded folder below it, even when `from`'s own entry is not loaded) to `to`; an
 * existing subtree at `to` is replaced.
 *
 * @example
 * ```ts
 * tree = moveSubtree(tree, 'src/old', 'src/new');
 * ```
 */
export function moveSubtree(tree: TreeData, from: string, to: string): TreeData {
  return applyBatch(tree, [{ kind: 'move', from, to }]);
}

/**
 * Puts `entry` into its parent folder, replacing any entry at the same path.
 *
 * @example
 * ```ts
 * tree = upsertEntry(tree, { path: 'src/new.ts', name: 'new.ts', kind: 'file' });
 * ```
 */
export function upsertEntry(tree: TreeData, entry: Entry): TreeData {
  return applyBatch(tree, [{ kind: 'upsert', entry }]);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareBySortKey(a: Entry, b: Entry, by: SortSpec['by']): number {
  switch (by) {
    case 'name':
      return collator.compare(a.name, b.name);
    case 'extension':
      return collator.compare(extname(a.name), extname(b.name));
    case 'mtime':
      return (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
    case 'size':
      return (a.size ?? 0) - (b.size ?? 0);
  }
}

/**
 * Folders always first; then the chosen key (reversed for `desc`); ties by name ascending, then path.
 *
 * @example
 * ```ts
 * entries.sort((a, b) => compareEntries(a, b, { by: 'name', direction: 'asc' }));
 * ```
 */
export function compareEntries(a: Entry, b: Entry, sort: SortSpec): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  const byKey = compareBySortKey(a, b, sort.by);
  const directed = sort.direction === 'desc' ? -byKey : byKey;
  if (directed !== 0) return directed;
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

const sortedChildrenCache = new WeakMap<ReadonlyMap<string, Entry>, Map<string, readonly Entry[]>>();

/**
 * `node`'s children in display order, memoized until the node's children change. The memo is keyed by the
 * children map, which a node shares with its status-only successors, so a status change never re-sorts. An
 * edited folder's order is derived from the order of the listing it was edited from: the changed children are
 * binary-searched into it, so renaming one child of a 100k-child folder does not re-sort the other 99,999.
 *
 * @example
 * ```ts
 * const rows = sortedChildren(tree.folders.get('')!, { by: 'size', direction: 'desc' });
 * ```
 */
export function sortedChildren(node: FolderNode, sort: SortSpec): readonly Entry[] {
  return memoizedSort(node.children, sort);
}

const isCopyOnWrite = (children: ReadonlyMap<string, Entry>): children is CopyOnWriteMap<Entry> =>
  children instanceof CopyOnWriteMap;

function memoizedSort(children: ReadonlyMap<string, Entry>, sort: SortSpec): readonly Entry[] {
  let bySort = sortedChildrenCache.get(children);
  if (!bySort) sortedChildrenCache.set(children, (bySort = new Map<string, readonly Entry[]>()));
  const sortKey = `${sort.by}:${sort.direction}`;
  let sorted = bySort.get(sortKey);
  if (!sorted) {
    sorted = isCopyOnWrite(children)
      ? sortReusingTheBaseOrder(children, sort)
      : [...children.values()].sort((a, b) => compareEntries(a, b, sort));
    bySort.set(sortKey, sorted);
  }
  return sorted;
}

function sortReusingTheBaseOrder(children: CopyOnWriteMap<Entry>, sort: SortSpec): readonly Entry[] {
  const baseOrder = memoizedSort(children.base, sort);
  const changes = children.changesOverBase;
  if (changes.size === 0) return baseOrder;
  const compare = (a: Entry, b: Entry): number => compareEntries(a, b, sort);
  const replacedOrDeleted = new Set<Entry | undefined>(
    [...changes.keys()].map((key) => children.base.get(key)),
  );
  const unchanged = baseOrder.filter((entry) => !replacedOrDeleted.has(entry));
  const changed = [...changes.values()].filter((entry): entry is Entry => entry !== DELETED).sort(compare);
  return insertSorted(unchanged, changed, compare);
}

function insertSorted(
  sorted: readonly Entry[],
  insertions: readonly Entry[],
  compare: (a: Entry, b: Entry) => number,
): Entry[] {
  const runs: Array<readonly Entry[]> = [];
  let copiedUpTo = 0;
  for (const insertion of insertions) {
    const position = firstPositionNotBefore(sorted, insertion, compare, copiedUpTo);
    runs.push(sorted.slice(copiedUpTo, position), [insertion]);
    copiedUpTo = position;
  }
  runs.push(sorted.slice(copiedUpTo));
  return runs.flat();
}

function firstPositionNotBefore(
  sorted: readonly Entry[],
  entry: Entry,
  compare: (a: Entry, b: Entry) => number,
  from: number,
): number {
  let low = from;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(sorted[middle]!, entry) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface FlattenFrame {
  siblings: readonly Entry[];
  next: number;
  depth: number;
  parent: string;
}

/**
 * Every visible row below `opts.root`, in display order. The reference implementation, for tests and small
 * consumers: it walks every open folder per call. Rendering uses `createVisibleRowIndex`, which gives the
 * same rows by index without building the list.
 *
 * @example
 * ```ts
 * const rows = flattenVisible(tree, { root: '', expanded: new Set(['src']), sort });
 * ```
 */
export function flattenVisible(
  tree: TreeData,
  opts: { root: string; expanded: ReadonlySet<string>; sort: SortSpec },
): VisibleRow[] {
  const { expanded, sort } = opts;
  const childrenOf = (path: string): readonly Entry[] => {
    const node = tree.folders.get(path);
    return node ? sortedChildren(node, sort) : [];
  };
  const rows: VisibleRow[] = [];
  const stack: FlattenFrame[] = [{ siblings: childrenOf(opts.root), next: 0, depth: 0, parent: opts.root }];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const entry = frame.siblings[frame.next++];
    if (!entry) {
      stack.pop();
      continue;
    }
    const isExpanded = entry.kind === 'directory' && expanded.has(entry.path);
    rows.push({
      path: entry.path,
      entry,
      depth: frame.depth,
      parentPath: frame.parent,
      isExpanded,
      status: statusOf(tree, entry.path),
      posInSet: frame.next,
      setSize: frame.siblings.length,
    });
    if (isExpanded) {
      stack.push({ siblings: childrenOf(entry.path), next: 0, depth: frame.depth + 1, parent: entry.path });
    }
  }
  return rows;
}
