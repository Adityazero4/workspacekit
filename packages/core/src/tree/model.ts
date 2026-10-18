import { basename, extname, isSameOrDescendant, parentPath } from '../path';
import type { Entry } from '../types';

export type FolderStatus = 'idle' | 'loading' | 'loaded' | 'error';
/** One folder whose children are known (or being fetched). Immutable: a change makes a new node, so an untouched node keeps its identity. */
export interface FolderNode {
  readonly path: string;
  /** Keyed by child name. */
  readonly children: ReadonlyMap<string, Entry>;
  readonly status: FolderStatus;
}
/** Keyed by folder path (root `''`). A folder without a node is 'idle' and its children are unknown. */
export interface TreeData {
  readonly folders: ReadonlyMap<string, FolderNode>;
}
export type TreeOp =
  | { kind: 'listing'; folder: string; depth: number; entries: Entry[] }
  | { kind: 'remove'; path: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'upsert'; entry: Entry }
  | { kind: 'status'; path: string; status: FolderStatus };
export interface SortSpec {
  by: 'name' | 'extension' | 'mtime' | 'size';
  direction: 'asc' | 'desc';
}
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

/** An overlay larger than this is folded into a fresh base, so `fork` stays O(√size). */
const overlayLimit = (size: number): number => 64 + 8 * Math.sqrt(size);

/**
 * Copy-on-write map: a `base` that is never written, plus a private overlay (`null` marks a deletion).
 * `fork()` costs O(overlay), not O(size), so a 1M-child folder can change one child without a 1M copy.
 * Only `applyBatch` writes, and only to forks it made itself in the current batch.
 */
class Layered<V> implements ReadonlyMap<string, V> {
  readonly #base: ReadonlyMap<string, V>;
  readonly #over: Map<string, V | null>;
  #size: number;
  constructor(base: ReadonlyMap<string, V> = new Map(), over: Map<string, V | null> = new Map(), size = base.size) {
    this.#base = base;
    this.#over = over;
    this.#size = size;
  }
  static of<V>(m: ReadonlyMap<string, V>): Layered<V> {
    return m instanceof Layered ? (m as Layered<V>) : new Layered(m);
  }
  get size(): number {
    return this.#size;
  }
  get(k: string): V | undefined {
    const v = this.#over.get(k);
    return v === null ? undefined : (v ?? this.#base.get(k));
  }
  has(k: string): boolean {
    return this.get(k) !== undefined;
  }
  fork(): Layered<V> {
    return new Layered(this.#base, new Map(this.#over), this.#size);
  }
  /** Same contents with an empty overlay once the overlay has outgrown its limit. */
  compact(): Layered<V> {
    return this.#over.size > overlayLimit(this.#base.size) ? new Layered(new Map(this)) : this;
  }
  set(k: string, v: V): void {
    if (!this.has(k)) this.#size++;
    this.#over.set(k, v);
  }
  delete(k: string): void {
    if (!this.has(k)) return;
    this.#size--;
    if (this.#base.has(k)) this.#over.set(k, null);
    else this.#over.delete(k);
  }
  *#merged(): Generator<[string, V], undefined> {
    for (const e of this.#base) if (!this.#over.has(e[0])) yield e;
    for (const [k, v] of this.#over) if (v !== null) yield [k, v];
  }
  entries(): MapIterator<[string, V]> {
    return this.#over.size === 0 ? this.#base.entries() : this.#merged();
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
  *#mergedKeys(): Generator<string, undefined> {
    for (const [k] of this.#merged()) yield k;
  }
  *#mergedValues(): Generator<V, undefined> {
    for (const [, v] of this.#merged()) yield v;
  }
  keys(): MapIterator<string> {
    return this.#over.size === 0 ? this.#base.keys() : this.#mergedKeys();
  }
  values(): MapIterator<V> {
    return this.#over.size === 0 ? this.#base.values() : this.#mergedValues();
  }
  forEach(fn: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
}

interface Draft {
  path: string;
  children: Layered<Entry>;
  status: FolderStatus;
}

/**
 * A node the walk from its parent cannot reach: its parent has no node, or the parent's children don't list it as a
 * directory (a folder opened from search, or under a stale listing).
 */
function isDetached(m: ReadonlyMap<string, FolderNode>, k: string): boolean {
  return k !== '' && m.get(parentPath(k))?.children.get(basename(k))?.kind !== 'directory';
}

/** Detached node paths per tree map. Carried from batch to batch (few in practice); a full pass only for a map applyBatch did not make. */
const detachedCache = new WeakMap<ReadonlyMap<string, FolderNode>, ReadonlySet<string>>();
function detachedIn(m: ReadonlyMap<string, FolderNode>): ReadonlySet<string> {
  let out = detachedCache.get(m);
  if (!out) {
    const found = new Set<string>();
    for (const k of m.keys()) if (isDetached(m, k)) found.add(k);
    detachedCache.set(m, (out = found));
  }
  return out;
}

export function emptyTree(): TreeData {
  return { folders: new Layered() };
}

export function entryAt(tree: TreeData, path: string): Entry | undefined {
  return path === '' ? undefined : tree.folders.get(parentPath(path))?.children.get(basename(path));
}

export function statusOf(tree: TreeData, path: string): FolderStatus {
  return tree.folders.get(path)?.status ?? 'idle';
}

/** Applies `ops` in order. The outer map is copied at most once and each touched folder once; untouched nodes are shared. */
export function applyBatch(tree: TreeData, ops: TreeOp[]): TreeData {
  let folders: Layered<FolderNode> | undefined; // this batch's copy of the outer map
  const owned = new Set<FolderNode>(); // nodes made in this batch: their children may be edited in place
  const map = (): ReadonlyMap<string, FolderNode> => folders ?? tree.folders;
  const edit = (): Layered<FolderNode> => (folders ??= input.fork());
  const input = Layered.of(tree.folders);
  const fresh: string[] = []; // nodes set in this batch that were detached when set
  let below: Set<string> | undefined; // strict ancestors of every detached node; built on first need, then kept current
  const addAncestors = (k: string): void => {
    for (let q = k; q !== '' && below; ) {
      q = parentPath(q);
      if (below.has(q)) break;
      below.add(q);
    }
  };
  /** Call for a node set at a new path (or not attached by construction). An existing node keeps its attachment. */
  const track = (k: string): void => {
    if (!isDetached(map(), k)) return;
    fresh.push(k);
    addAncestors(k);
  };
  /**
   * Could a node lie strictly below `path` that is not reachable through `path`'s own node? Deleting a node always
   * deletes the nodes attached below it, so any such node has a detached ancestor-or-self below `path`, and every
   * detached node is indexed. Not cleared on delete, so a stale hit only costs a scan.
   */
  const hasNodeBelow = (path: string): boolean => {
    if (!below) {
      below = new Set();
      for (const k of detachedIn(tree.folders)) addAncestors(k);
      for (const k of fresh) addAncestors(k);
    }
    return below.has(path);
  };
  const put = (n: Draft, attached = false): void => {
    owned.add(n);
    edit().set(n.path, n);
    if (!attached) track(n.path);
  };
  const own = (path: string): Draft => {
    const cur = map().get(path);
    if (cur && owned.has(cur)) return cur as Draft;
    const n: Draft = { path, children: cur ? Layered.of(cur.children).fork() : new Layered(), status: cur?.status ?? 'idle' };
    put(n, cur !== undefined);
    return n;
  };
  const entry = (path: string): Entry | undefined => entryAt({ folders: map() }, path);
  /** Node paths at or below `path`, including folders loaded without their parents. Paths with no node at or below skip the scan. */
  const nodesUnder = (path: string): string[] => {
    if (!map().has(path) && !hasNodeBelow(path)) return [];
    // ponytail: O(loaded folders) key scan per folder remove/move; add a child-folder index if folder counts reach millions
    const out: string[] = [];
    for (const k of map().keys()) if (isSameOrDescendant(k, path)) out.push(k);
    return out;
  };

  const remove = (path: string): void => {
    const e = entry(path);
    const nodes = nodesUnder(path);
    if (e) own(parentPath(path)).children.delete(basename(path));
    for (const k of nodes) edit().delete(k);
  };

  const move = (from: string, to: string): void => {
    if (from === '' || to === '' || isSameOrDescendant(to, from)) return; // into itself (or a no-op)
    const e = entry(from);
    const nodes = nodesUnder(from).map((k) => map().get(k)!);
    if (!e && nodes.length === 0) return;
    if (e) own(parentPath(from)).children.delete(basename(from));
    for (const n of nodes) edit().delete(n.path);
    remove(to); // whatever was at `to` is replaced
    if (e) own(parentPath(to)).children.set(basename(to), { ...e, path: to, name: basename(to) });
    for (const n of nodes) {
      const path = to + n.path.slice(from.length);
      const children = new Map<string, Entry>();
      for (const [name, c] of n.children) children.set(name, { ...c, path: `${path}/${name}` });
      put({ path, children: new Layered(children), status: n.status });
    }
  };

  const upsert = (e: Entry): void => {
    if (e.kind !== 'directory') for (const k of nodesUnder(e.path)) edit().delete(k); // a file has no loaded folders below
    own(parentPath(e.path)).children.set(basename(e.path), e);
  };

  /**
   * Replace the `depth`-level window below `folder`; a deeper node survives only while its ancestor at the
   * window boundary is a listed directory. That also drops detached nodes whose boundary dir was never listed.
   * A directory marked `meta.incomplete` (the source did not walk it) is treated like one at the boundary: the
   * listing says nothing about its children, so it keeps whatever node it had and is never marked 'loaded' here.
   */
  const listing = (folder: string, depth: number, entries: Entry[]): void => {
    const rel = new Map<string, number>(); // parent path -> depth below `folder`, -1 outside it
    const relOf = (p: string): number => {
      let r = rel.get(p);
      if (r === undefined) {
        if (p === folder) r = 0;
        else if (folder !== '' && !p.startsWith(folder + '/')) r = -1;
        else {
          r = 1;
          for (let i = p.indexOf('/', folder === '' ? 0 : folder.length + 1); i !== -1; i = p.indexOf('/', i + 1)) r++;
        }
        rel.set(p, r);
      }
      return r;
    };
    const groups = new Map<string, Map<string, Entry>>(); // parent -> listed children
    for (const e of entries) {
      if (e.path === folder) continue;
      const p = parentPath(e.path);
      const r = relOf(p) + 1;
      if (r < 1 || r > depth) continue;
      let g = groups.get(p);
      if (!g) groups.set(p, (g = new Map()));
      g.set(basename(e.path), e);
    }
    const inner = new Set<string>(); // listed dirs above the boundary: fresh 'loaded' nodes
    const boundary = new Set<string>(); // listed dirs at the boundary (or incomplete): keep their node
    for (const [p, g] of groups) {
      const r = rel.get(p)! + 1;
      for (const e of g.values()) {
        if (e.kind !== 'directory') continue;
        if (r < depth && e.meta?.incomplete !== true) inner.add(e.path);
        else boundary.add(e.path);
      }
    }
    // nodes reachable through the old listing: walk its children
    const old = map().get(folder);
    const stack: [FolderNode, number][] = old ? [[old, 0]] : [];
    for (let top = stack.pop(); top; top = stack.pop()) {
      const [n, r] = top;
      for (const name of n.children.keys()) {
        const p = n.path === '' ? name : `${n.path}/${name}`;
        const child = map().get(p);
        if (!child || boundary.has(p)) continue;
        edit().delete(p);
        stack.push([child, r + 1]);
      }
    }
    // detached nodes below: one pass over the keys under `folder`; a node survives under a kept (boundary) dir
    if (hasNodeBelow(folder)) {
      // ponytail: O(loaded folders) key scan, only while a detached node sits below `folder`; a child-folder index if that gets hot
      const pre = folder === '' ? '' : `${folder}/`;
      const gone: string[] = [];
      for (const k of map().keys()) {
        if (k === folder || !k.startsWith(pre)) continue;
        let kept = false;
        for (let cut = pre.length - 1, r = 0; r < depth && !kept; r++) {
          cut = k.indexOf('/', cut + 1);
          kept = boundary.has(cut === -1 ? k : k.slice(0, cut)); // ancestor-or-self within the window
          if (cut === -1) break;
        }
        if (!kept) gone.push(k);
      }
      for (const k of gone) edit().delete(k);
    }
    put({ path: folder, children: new Layered(groups.get(folder) ?? new Map()), status: 'loaded' });
    for (const [p, g] of groups) {
      const attached = p === folder || inner.has(p); // its parent's fresh node lists it
      for (const e of g.values()) {
        if (inner.has(e.path)) put({ path: e.path, children: new Layered(groups.get(e.path) ?? new Map()), status: 'loaded' }, attached);
      }
    }
  };

  const status = (path: string, st: FolderStatus): void => {
    const cur = map().get(path);
    if ((cur?.status ?? 'idle') === st) return;
    if (st === 'idle' && cur!.children.size === 0) edit().delete(path);
    else {
      edit().set(path, { path, children: cur?.children ?? new Layered(), status: st }); // children shared, not copied
      if (!cur) track(path);
    }
  };

  for (const op of ops) {
    if (op.kind === 'listing') listing(op.folder, op.depth, op.entries);
    else if (op.kind === 'remove') remove(op.path);
    else if (op.kind === 'move') move(op.from, op.to);
    else if (op.kind === 'upsert') upsert(op.entry);
    else status(op.path, op.status);
  }
  if (!folders) return tree;
  for (const n of owned) (n as Draft).children = (n as Draft).children.compact();
  const out = folders.compact();
  if (below || detachedCache.has(tree.folders)) {
    const still = new Set<string>();
    for (const k of [...detachedIn(tree.folders), ...fresh]) if (out.has(k) && isDetached(out, k)) still.add(k);
    detachedCache.set(out, still);
  }
  return { folders: out };
}

/**
 * `entries` are the descendants of `folder` down to `depth` relative levels. Everything in that window is
 * replaced; deeper entries survive only while their ancestor at relative depth `depth` still exists.
 */
export function mergeListing(tree: TreeData, folder: string, depth: number, entries: Entry[]): TreeData {
  return applyBatch(tree, [{ kind: 'listing', folder, depth, entries }]);
}

export function removeSubtree(tree: TreeData, path: string): TreeData {
  return applyBatch(tree, [{ kind: 'remove', path }]);
}

/** Moves `from` (and every loaded folder below it, even when `from`'s own entry is not loaded) to `to`; an existing subtree at `to` is replaced. */
export function moveSubtree(tree: TreeData, from: string, to: string): TreeData {
  return applyBatch(tree, [{ kind: 'move', from, to }]);
}

export function upsertEntry(tree: TreeData, entry: Entry): TreeData {
  return applyBatch(tree, [{ kind: 'upsert', entry }]);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders always first; then the chosen key (reversed for `desc`); ties by name ascending, then path. */
export function compareEntries(a: Entry, b: Entry, sort: SortSpec): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  let c = 0;
  if (sort.by === 'name') c = collator.compare(a.name, b.name);
  else if (sort.by === 'extension') c = collator.compare(extname(a.name), extname(b.name));
  else if (sort.by === 'mtime') c = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
  else c = (a.size ?? 0) - (b.size ?? 0);
  if (sort.direction === 'desc') c = -c;
  if (c !== 0) return c;
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Keyed by the children map, which a node shares with its status-only successors, so a status change never re-sorts. */
const sortCache = new WeakMap<ReadonlyMap<string, Entry>, Map<string, readonly Entry[]>>();

/** `node`'s children in display order, memoized until the node's children change. */
export function sortedChildren(node: FolderNode, sort: SortSpec): readonly Entry[] {
  let bySort = sortCache.get(node.children);
  if (!bySort) sortCache.set(node.children, (bySort = new Map()));
  const key = `${sort.by}:${sort.direction}`;
  let list = bySort.get(key);
  if (!list) bySort.set(key, (list = [...node.children.values()].sort((x, y) => compareEntries(x, y, sort))));
  return list;
}

interface Frame {
  list: readonly Entry[];
  i: number;
  depth: number;
  parent: string;
}

/**
 * Every visible row below `opts.root`, in display order. The reference implementation, for tests and small
 * consumers: it walks every open folder per call. Rendering uses `createVisibleRowIndex`, which gives the same rows
 * by index without building the list.
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
  const stack: Frame[] = [{ list: childrenOf(opts.root), i: 0, depth: 0, parent: opts.root }];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    const entry = f.list[f.i++];
    if (!entry) {
      stack.pop();
      continue;
    }
    const isExpanded = entry.kind === 'directory' && expanded.has(entry.path);
    rows.push({
      path: entry.path,
      entry,
      depth: f.depth,
      parentPath: f.parent,
      isExpanded,
      status: statusOf(tree, entry.path),
      posInSet: f.i,
      setSize: f.list.length,
    });
    if (isExpanded) stack.push({ list: childrenOf(entry.path), i: 0, depth: f.depth + 1, parent: entry.path });
  }
  return rows;
}
