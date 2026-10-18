import { FsError, toFsError } from '../errors';
import { uniqueName, validateName, validateTransfer } from '../naming';
import { basename, isSameOrDescendant, joinPath, normalizePath, parentPath, remapPrefix } from '../path';
import type { ChangeEvent, Entry, EntryKind, FileSystemAdapter, TransferOptions } from '../types';
import {
  applyBatch,
  emptyTree,
  entryAt,
  mergeListing,
  moveSubtree,
  removeSubtree,
  statusOf,
  upsertEntry,
  type FolderNode,
  type FolderStatus,
  type TreeData,
  type TreeOp,
} from './model';

export interface TreeSnapshot {
  readonly version: number;
  readonly tree: TreeData;
  readonly errors: ReadonlyMap<string, FsError>;
  readonly pending: ReadonlySet<string>;
  /** Changed by someone other than the user since `markSeen`. */
  readonly changed: ReadonlySet<string>;
}
export interface TreeStore {
  getSnapshot(): TreeSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Load failures land in `errors` / `onError`; rejects only for a bad path or one outside the store root (`invalid`),
   * before any request. Non-forced loads are deduped and skipped when already loaded.
   */
  loadFolder(path: string, opts?: { force?: boolean }): Promise<void>;
  create(parent: string, name: string, kind: EntryKind): Promise<Entry>;
  rename(path: string, newName: string): Promise<Entry>;
  move(path: string, toDir: string, opts?: TransferOptions): Promise<Entry>;
  copy(path: string, toDir: string): Promise<Entry>;
  duplicate(path: string): Promise<Entry>;
  remove(path: string): Promise<void>;
  applyChanges(events: ChangeEvent[]): void;
  markSeen(path: string): void;
  dispose(): void;
}

const unsupported = (): FsError => new FsError('invalid', 'operation not supported');
const notRoot = (path: string, op: string): void => {
  if (path === '') throw new FsError('invalid', `cannot ${op} the root`, { path });
};

/** A subtree lifted out of a tree, so a failed optimistic removal can be put back. Nodes are immutable, so this is cheap. */
interface Captured {
  entry: Entry | undefined;
  nodes: FolderNode[];
}

function capture(tree: TreeData, path: string): Captured {
  const nodes: FolderNode[] = [];
  for (const n of tree.folders.values()) if (isSameOrDescendant(n.path, path)) nodes.push(n);
  return { entry: entryAt(tree, path), nodes };
}

/** The folder's children are known: it was listed, or entries were placed in it. */
function knows(tree: TreeData, path: string): boolean {
  const n = tree.folders.get(path);
  return n !== undefined && (n.status === 'loaded' || n.children.size > 0);
}

/**
 * `path` is known to be gone: the nearest ancestor-or-self below `stop` whose parent listing is known is missing from
 * it. Returns that listing's folder, else undefined. A folder opened from search (no known listing on the way up) is not gone.
 */
function lostAt(tree: TreeData, path: string, stop: string): string | undefined {
  for (let q = path; q !== stop && q !== ''; q = parentPath(q)) {
    if (knows(tree, parentPath(q))) return entryAt(tree, q) ? undefined : parentPath(q);
  }
  return undefined;
}

/** Inverse of `removeSubtree` applied to the *current* tree; a no-op when the parent is no longer loaded. */
function restore(tree: TreeData, cap: Captured, path: string): TreeData {
  if ((!cap.entry && cap.nodes.length === 0) || !knows(tree, parentPath(path))) return tree;
  const ops: TreeOp[] = cap.entry ? [{ kind: 'upsert', entry: cap.entry }] : [];
  for (const n of cap.nodes) {
    for (const entry of n.children.values()) ops.push({ kind: 'upsert', entry });
    ops.push({ kind: 'status', path: n.path, status: n.status });
  }
  return applyBatch(tree, ops);
}

function withStatus(tree: TreeData, path: string, status: FolderStatus): TreeData {
  return applyBatch(tree, [{ kind: 'status', path, status }]);
}

export function createTreeStore(
  adapter: FileSystemAdapter,
  opts: { fetchDepth?: number; root?: string; onError?(e: FsError): void } = {},
): TreeStore {
  const fetchDepth = opts.fetchDepth ?? 2;
  const root = normalizePath(opts.root ?? '');
  const inRoot = (p: string): boolean => isSameOrDescendant(p, root);

  let tree = emptyTree();
  let errors: ReadonlyMap<string, FsError> = new Map();
  let changed: ReadonlySet<string> = new Set();
  const pendingCount = new Map<string, number>();
  let pending: ReadonlySet<string> = new Set();
  let version = 0;
  let snapshot: TreeSnapshot = { version, tree, errors, pending, changed };
  const listeners = new Set<() => void>();
  let scheduled = false;
  let disposed = false;

  /** New snapshot now; listeners are told once per microtask. */
  const commit = (): void => {
    snapshot = { version: ++version, tree, errors, pending, changed };
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) for (const l of [...listeners]) l();
    });
  };
  const track = (paths: string[], by: 1 | -1): void => {
    for (const p of paths) {
      const n = (pendingCount.get(p) ?? 0) + by;
      if (n > 0) pendingCount.set(p, n);
      else pendingCount.delete(p);
    }
    pending = new Set(pendingCount.keys());
  };

  const isLoaded = (t: TreeData, p: string): boolean => statusOf(t, p) === 'loaded';

  // --- loading -----------------------------------------------------------------------------------------------
  /** Request id of the listing each folder is waiting for; only in-flight folders have one. */
  const generation = new Map<string, number>();
  /** Request id of each folder's latest listing request, settled or not. ponytail: one number per folder ever requested, never pruned. */
  const started = new Map<string, number>();
  /** In-flight folders the caller asked for (loadFolder): whichever of their listings lands is applied. */
  const wanted = new Set<string>();
  let lastGen = 0;
  const inflight = new Map<string, Promise<void>>();

  /**
   * `path` and everything below it is gone (removed, moved away, replaced or recreated): discard in-flight listings
   * for it and clear its errors. Returns the ops that reset its 'loading' statuses (those responses are never applied).
   */
  const forget = (t: TreeData, path: string): TreeOp[] => {
    const ops: TreeOp[] = [];
    for (const k of generation.keys()) {
      if (!isSameOrDescendant(k, path)) continue;
      generation.delete(k);
      inflight.delete(k);
      wanted.delete(k);
      if (statusOf(t, k) === 'loading') ops.push({ kind: 'status', path: k, status: 'idle' });
    }
    if ([...errors.keys()].some((k) => isSameOrDescendant(k, path))) {
      errors = new Map([...errors].filter(([k]) => !isSameOrDescendant(k, path)));
    }
    return ops;
  };

  const fail = (path: string, err: FsError): void => {
    tree = withStatus(tree, path, 'error');
    errors = new Map(errors).set(path, err);
    commit();
    opts.onError?.(err);
  };

  /**
   * A listing the caller asked for is applied as is: the server's answer is the truth, and a folder that is gone fails
   * with the adapter's own error. Background listings of a folder a known ancestor listing lacks are dropped instead,
   * so a removed folder never comes back.
   */
  const fetchFolder = async (path: string, explicit: boolean): Promise<void> => {
    const gen = ++lastGen;
    generation.set(path, gen);
    started.set(path, gen);
    if (explicit) wanted.add(path);
    if (!isLoaded(tree, path)) {
      tree = withStatus(tree, path, 'loading');
      commit();
    }
    try {
      const entries = await adapter.list(path, { depth: fetchDepth });
      if (disposed || generation.get(path) !== gen) return; // a newer request owns this folder, or it was removed
      const asked = wanted.has(path);
      const stale = lostAt(tree, path, root);
      if (stale !== undefined && !asked) {
        // removed/moved/dropped while loading: applying would resurrect a ghost subtree
        if (statusOf(tree, path) === 'loading') {
          tree = withStatus(tree, path, 'idle');
          commit();
        }
        return;
      }
      tree = mergeListing(tree, path, fetchDepth, entries);
      const gone: TreeOp[] = [];
      for (const k of generation.keys()) {
        if (k !== path && !wanted.has(k) && isSameOrDescendant(k, path) && lostAt(tree, k, path) !== undefined) gone.push(...forget(tree, k));
      }
      tree = applyBatch(tree, gone);
      if (errors.has(path)) {
        const e = new Map(errors);
        e.delete(path);
        errors = e;
      }
      commit();
      // the known ancestor listing that lacks it predates it: one background reload, shared by every load under it
      // that was requested before that reload (an older reload still in flight is superseded, it may predate it too)
      if (stale !== undefined && (started.get(stale) ?? 0) < gen) void load(stale, true, false);
    } catch (e) {
      if (disposed || generation.get(path) !== gen) return;
      fail(path, toFsError(e));
    } finally {
      if (generation.get(path) === gen) {
        generation.delete(path);
        wanted.delete(path);
      }
    }
  };

  const load = (path: string, force: boolean, explicit: boolean): Promise<void> => {
    if (!force) {
      if (isLoaded(tree, path)) return Promise.resolve();
      const running = inflight.get(path);
      if (running) {
        if (explicit && generation.has(path)) wanted.add(path);
        return running;
      }
    }
    const run: Promise<void> = fetchFolder(path, explicit).finally(() => {
      if (inflight.get(path) === run) inflight.delete(path);
    });
    inflight.set(path, run);
    return run;
  };
  const loadFolder = async (p: string, o?: { force?: boolean }): Promise<void> => {
    const path = normalizePath(p);
    if (!inRoot(path)) throw new FsError('invalid', `outside the store root: ${path}`, { path });
    return load(path, o?.force === true, true);
  };

  const ensureLoaded = async (dir: string): Promise<void> => {
    await loadFolder(dir);
    if (!isLoaded(tree, dir)) throw errors.get(dir) ?? new FsError('unknown', `cannot load ${dir}`, { path: dir });
  };

  // --- mutations ---------------------------------------------------------------------------------------------
  /**
   * Apply `optimistic`, await `call`, then confirm or roll back. Rollback is the inverse operation applied to the
   * current tree (never a stored copy), so listings that landed in the meantime survive.
   */
  const reloadAll = async (parents: string[]): Promise<void> => {
    await Promise.all([...new Set(parents)].map((p) => load(p, true, false)));
  };

  const mutate = async <T>(
    paths: string[],
    reload: string[],
    optimistic: (t: TreeData) => TreeData,
    rollback: (t: TreeData) => TreeData,
    call: () => Promise<T>,
    confirm: (t: TreeData, result: T) => TreeData,
  ): Promise<T> => {
    tree = optimistic(tree);
    track(paths, 1);
    commit();
    let result: T;
    try {
      result = await call();
    } catch (e) {
      tree = rollback(tree);
      track(paths, -1);
      commit();
      await reloadAll(reload); // a partial server-side failure leaves the truth elsewhere: self-heal
      throw toFsError(e);
    }
    tree = confirm(tree, result);
    track(paths, -1);
    commit();
    await reloadAll(reload);
    return result;
  };

  const dropChanged = (path: string): void => {
    if (![...changed].some((p) => isSameOrDescendant(p, path))) return;
    changed = new Set([...changed].filter((p) => !isSameOrDescendant(p, path)));
  };

  const siblingNames = (parent: string, except?: string): Set<string> => {
    const out = new Set<string>();
    for (const [name, e] of tree.folders.get(parent)?.children ?? []) if (e.path !== except) out.add(name);
    return out;
  };

  const transfer = async (op: 'move' | 'copy', from: string, to: string, o?: TransferOptions): Promise<Entry> => {
    const src = entryAt(tree, from);
    if (!src) throw new FsError('not_found', `not found: ${from}`, { path: from });
    if (isSameOrDescendant(from, to)) throw new FsError('invalid', `cannot ${op} ${from} to ${to}`, { path: to });
    if (entryAt(tree, to) && !o?.overwrite) throw new FsError('conflict', `already exists: ${to}`, { path: to });
    const call = op === 'move' ? adapter.move : adapter.copy;
    if (!call) throw unsupported();
    tree = applyBatch(tree, [...(op === 'move' ? forget(tree, from) : []), ...forget(tree, to)]); // a copy leaves `from` alone
    const lifted = capture(tree, from);
    const replaced = capture(tree, to);
    let placed: Entry | undefined; // the exact object the optimistic step put at `to`
    return mutate(
      [from, to],
      [parentPath(from), parentPath(to)],
      (t) => {
        const next =
          op === 'move'
            ? moveSubtree(t, from, to)
            : upsertEntry(removeSubtree(t, to), { ...src, path: to, name: basename(to) });
        placed = entryAt(next, to);
        return next;
      },
      (t) => {
        let next = t;
        // undo only what we placed; a listing may have replaced it with the real entry at `to`
        const ours = entryAt(next, to) === placed;
        if (op === 'move' && ours) next = moveSubtree(next, to, from);
        else if (ours) next = removeSubtree(next, to);
        if (op === 'move' && !entryAt(next, from)) next = restore(next, lifted, from);
        return restore(next, replaced, to);
      },
      () => call.call(adapter, from, to, o),
      (t, r) => upsertEntry(t, r),
    );
  };

  const move = async (p: string, d: string, o?: TransferOptions): Promise<Entry> => {
    if (!adapter.move) throw unsupported();
    const path = normalizePath(p);
    notRoot(path, 'move');
    const toDir = normalizePath(d);
    const problem = validateTransfer('move', path, toDir);
    if (problem === 'into_self') throw new FsError('invalid', `cannot move ${path} into itself`, { path });
    if (problem === 'noop') {
      const e = entryAt(tree, path);
      if (!e) throw new FsError('not_found', `not found: ${path}`, { path });
      return e;
    }
    await ensureLoaded(toDir);
    return transfer('move', path, joinPath(toDir, basename(path)), o);
  };

  const copy = async (p: string, d: string): Promise<Entry> => {
    if (!adapter.copy) throw unsupported();
    const path = normalizePath(p);
    const toDir = normalizePath(d);
    if (validateTransfer('copy', path, toDir) === 'into_self') {
      throw new FsError('invalid', `cannot copy ${path} into itself`, { path });
    }
    await ensureLoaded(toDir);
    return transfer('copy', path, joinPath(toDir, uniqueName(basename(path), siblingNames(toDir))));
  };

  const create = async (p: string, name: string, kind: EntryKind): Promise<Entry> => {
    if (!adapter.create) throw unsupported();
    const parent = normalizePath(p);
    await ensureLoaded(parent);
    const problem = validateName(name, siblingNames(parent));
    if (problem) {
      throw new FsError(problem === 'duplicate' ? 'conflict' : 'invalid', `invalid name "${name}": ${problem}`, { path: parent });
    }
    const path = joinPath(parent, name);
    const entry: Entry = { path, name: basename(path), kind, mtimeMs: Date.now(), ...(kind === 'file' ? { size: 0 } : {}) };
    return mutate(
      [path],
      [parent],
      (t) => {
        const ops: TreeOp[] = [{ kind: 'upsert', entry }];
        if (kind === 'directory') ops.push({ kind: 'listing', folder: path, depth: 1, entries: [] }); // known empty, loaded
        return applyBatch(t, ops);
      },
      (t) => (entryAt(t, path) === entry ? removeSubtree(t, path) : t),
      () => adapter.create!(path, kind),
      (t, r) => upsertEntry(t, r),
    );
  };

  const rename = async (p: string, newName: string): Promise<Entry> => {
    if (!adapter.move) throw unsupported();
    const path = normalizePath(p);
    notRoot(path, 'rename');
    const entry = entryAt(tree, path);
    if (!entry) throw new FsError('not_found', `not found: ${path}`, { path });
    if (newName.normalize('NFC') === entry.name) return entry;
    const parent = parentPath(path);
    const problem = validateName(newName, siblingNames(parent, path));
    if (problem) {
      throw new FsError(problem === 'duplicate' ? 'conflict' : 'invalid', `invalid name "${newName}": ${problem}`, { path });
    }
    return transfer('move', path, joinPath(parent, newName));
  };

  const remove = async (p: string): Promise<void> => {
    if (!adapter.delete) throw unsupported();
    const path = normalizePath(p);
    notRoot(path, 'remove');
    tree = applyBatch(tree, forget(tree, path));
    const lifted = capture(tree, path);
    dropChanged(path);
    await mutate(
      [path],
      [parentPath(path)],
      (t) => removeSubtree(t, path),
      (t) => restore(t, lifted, path),
      () => adapter.delete!(path),
      (t) => t,
    );
  };

  // --- live changes ------------------------------------------------------------------------------------------
  /** At most one resync pass runs; resyncs that arrive meanwhile fold into a single follow-up pass. */
  let resyncing = false;
  let resyncAgain = false;
  const resync = async (): Promise<void> => {
    if (resyncing) {
      resyncAgain = true;
      return;
    }
    resyncing = true;
    try {
      do {
        resyncAgain = false;
        const paths: string[] = [];
        for (const n of tree.folders.values()) if (n.status === 'loaded' || n.status === 'loading') paths.push(n.path);
        await Promise.all(paths.map((p) => load(p, true, false)));
      } while (resyncAgain && !disposed);
    } finally {
      resyncing = false;
    }
  };

  const applyChanges = (events: ChangeEvent[]): void => {
    if (disposed || events.length === 0) return;
    let t = tree;
    const ops: TreeOp[] = []; // applied to `t` in one batch
    const touched = new Set<string>(); // paths removed or moved by `ops` not yet applied
    /** `t`, first brought up to date when a pending op could change what is read at `p`. */
    const at = (p: string): TreeData => {
      for (let q = p; ; q = parentPath(q)) {
        if (touched.has(q)) {
          t = applyBatch(t, ops.splice(0));
          touched.clear();
          break;
        }
        if (q === '') break;
      }
      return t;
    };
    let seen = changed;
    let seenCopied = false;
    const errorsBefore = errors;
    let marksBelow: Map<string, number> | undefined; // changed marks strictly below each folder, built on first use
    const count = (p: string, by: 1 | -1): void => {
      if (!marksBelow) return;
      for (let q = p; q !== ''; ) (q = parentPath(q)), marksBelow.set(q, (marksBelow.get(q) ?? 0) + by);
    };
    const mark = (p: string): void => {
      if (seen.has(p)) return;
      if (!seenCopied) (seen = new Set(seen)), (seenCopied = true);
      (seen as Set<string>).add(p);
      count(p, 1);
    };
    /** Drops the marks at or below `p` and returns them; scans the set only when some exist. */
    const unmarkUnder = (p: string): string[] => {
      if (!marksBelow) {
        marksBelow = new Map();
        for (const m of seen) count(m, 1);
      }
      const gone = marksBelow.get(p) ? [...seen].filter((m) => isSameOrDescendant(m, p)) : seen.has(p) ? [p] : [];
      if (gone.length === 0) return gone;
      if (!seenCopied) (seen = new Set(seen)), (seenCopied = true);
      for (const m of gone) (seen as Set<string>).delete(m), count(m, -1);
      return gone;
    };
    const reload = new Set<string>();
    const refetch = new Set<string>();
    let resyncSeen = false;
    for (const ev of events) {
      if (ev.type === 'resync') {
        resyncSeen = true;
        continue;
      }
      let path: string;
      let old: string | undefined;
      try {
        path = normalizePath(ev.path);
        old = ev.oldPath === undefined ? undefined : normalizePath(ev.oldPath);
      } catch {
        continue;
      }
      const external = ev.actor !== undefined && ev.actor !== 'user';
      let type = ev.type;
      if (type === 'moved') {
        if (old === undefined || !inRoot(old)) type = 'created';
        else if (!inRoot(path)) (type = 'deleted'), (path = old);
        else if (isSameOrDescendant(path, old)) continue; // same path or into itself
      }
      if (!inRoot(path)) continue;
      const parent = parentPath(path);
      if (type === 'deleted') {
        ops.push(...forget(t, path), { kind: 'remove', path });
        touched.add(path);
        unmarkUnder(path);
      } else if (type === 'moved') {
        const from = old!;
        ops.push(...forget(t, from), ...forget(t, path));
        const had = entryAt(at(from), from) !== undefined;
        const parentLoaded = isLoaded(at(parent), parent);
        // loaded folders below `from` follow it even when its own entry is not loaded (the model's move is descendant-safe);
        // only a known entry moving into an unloaded parent is dropped from view
        ops.push(parentLoaded || !had ? { kind: 'move', from, to: path } : { kind: 'remove', path: from });
        touched.add(from).add(path);
        if (!had && parentLoaded) reload.add(parent); // the listing brings the entry itself
        for (const m of unmarkUnder(from)) mark(remapPrefix(m, from, path));
        if (external && parentLoaded) mark(path);
      } else {
        if (type === 'created') {
          // a recreated path: listings already in flight are stale; ones the caller asked for are requested again
          for (const k of wanted) if (isSameOrDescendant(k, path)) refetch.add(k);
          ops.push(...forget(t, path));
        }
        if (isLoaded(at(parent), parent)) {
          reload.add(parent); // listing replaces the entry wholesale, so a dir<->file switch drops stale children
          if (external) mark(path);
        }
      }
    }
    t = applyBatch(t, ops);
    if (t !== tree || seen !== changed || errors !== errorsBefore) {
      tree = t;
      changed = seen;
      commit();
    }
    if (resyncSeen) void resync(); // reloads every loaded folder, `reload` included
    else for (const p of reload) if (isLoaded(tree, p)) void load(p, true, false);
    for (const p of refetch) void load(p, true, true);
  };

  const markSeen = (p: string): void => {
    const path = normalizePath(p);
    if (!changed.has(path)) return;
    const next = new Set(changed);
    next.delete(path);
    changed = next;
    commit();
  };

  const unwatch = adapter.watch?.(applyChanges);

  return {
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    loadFolder,
    create,
    rename,
    move,
    copy,
    duplicate: (p) => {
      const path = normalizePath(p);
      return copy(path, parentPath(path));
    },
    remove,
    applyChanges,
    markSeen,
    dispose: () => {
      disposed = true;
      unwatch?.();
      listeners.clear();
    },
  };
}
