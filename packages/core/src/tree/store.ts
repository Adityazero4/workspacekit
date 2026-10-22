import { normalizedOrUndefined } from '../adapter-paths';
import { FsError, toFsError } from '../errors';
import { uniqueName, validateName, validateTransfer, type NameProblem } from '../naming';
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
import { ChangedBelowCounts, ChangeMarks } from './change-marks';
import { ListingRequests } from './listing-requests';
import { OwnMoveEchoes, type OwnMove } from './own-move-echoes';
import { PendingTreeOps } from './pending-ops';

/**
 * Options for `TreeStore.move` and `TreeStore.copy`: the adapter's `TransferOptions` plus the destination
 * name.
 *
 * @example
 * ```ts
 * await store.copy('a.txt', 'docs', { name: 'b.txt', overwrite: true });
 * ```
 */
export interface TreeTransferOptions extends TransferOptions {
  /**
   * The destination basename (default: the source's name, or a free `… copy` name for a copy without
   * `overwrite`). Adapters never receive it: their `to` is already the full path.
   */
  name?: string;
}
/**
 * An immutable view of a `TreeStore`; a new snapshot (with a higher `version`) follows every change.
 *
 * @example
 * ```ts
 * const { tree, errors, pending } = store.getSnapshot();
 * ```
 */
export interface TreeSnapshot {
  readonly version: number;
  readonly tree: TreeData;
  readonly errors: ReadonlyMap<string, FsError>;
  readonly pending: ReadonlySet<string>;
  /** Changed by someone other than the user since `markSeen`. */
  readonly changed: ReadonlySet<string>;
  /**
   * The folders with at least one path in `changed` below them, without the root. A new set only when a
   * folder joins or leaves it.
   */
  readonly changedBelow: ReadonlySet<string>;
  /**
   * The path most recently marked in `changed` by someone other than the user, with a `sequence` that grows
   * by one for every such mark, even of a path already marked; `null` before the first. Remapping marks when
   * a folder moves and `markSeen` leave it alone, so a follower can compare `sequence` instead of diffing
   * `changed`.
   */
  readonly latestExternalChange: { readonly path: string; readonly sequence: number } | null;
}
/**
 * The tree state for one adapter, created by `createTreeStore`. Members are plain functions, safe to pass
 * unbound.
 *
 * @example
 * ```ts
 * const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
 * ```
 */
export interface TreeStore {
  getSnapshot: () => TreeSnapshot;
  /** The first call also subscribes to `adapter.watch`; that subscription lasts until `dispose`. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Load failures land in `errors` / `onError`; rejects only for a bad path or one outside the store root
   * (`invalid`), before any request. Non-forced loads are deduped and skipped when already loaded. Settles
   * once no newer load of the folder (such as one a change below it requested again) is running; a trailing
   * reload that churn below the folder queued is not waited for.
   */
  loadFolder: (path: string, opts?: { force?: boolean }) => Promise<void>;
  create: (parent: string, name: string, kind: EntryKind) => Promise<Entry>;
  rename: (path: string, newName: string) => Promise<Entry>;
  /**
   * Moves into `toDir`, under `opts.name` when given; a taken name rejects with `conflict` unless
   * `overwrite`.
   */
  move: (path: string, toDir: string, opts?: TreeTransferOptions) => Promise<Entry>;
  /**
   * Copies into `toDir` under `opts.name`; without one, under a free `… copy` name, or the source's own name
   * (replacing that entry) with `overwrite`.
   */
  copy: (path: string, toDir: string, opts?: TreeTransferOptions) => Promise<Entry>;
  duplicate: (path: string) => Promise<Entry>;
  /**
   * Deletes the entry at `path` (a folder with everything in it): it leaves the tree at once and comes back
   * if the adapter fails. Rejects with `invalid` for the root.
   */
  remove: (path: string) => Promise<void>;
  /**
   * Folds a batch of change events into one tree update and reloads the folders they touch. The store calls
   * it for `adapter.watch` itself; call it only for events from another source.
   */
  applyChanges: (events: ChangeEvent[]) => void;
  /** Removes `path` from `changed`, such as once the user has looked at it. */
  markSeen: (path: string) => void;
  /**
   * Calls `listener` once per moved entry (not per descendant) with its old and new path: after a store
   * `move` or `rename` commits, and for each `moved` change event (one inside the root; moves into or out of
   * it arrive as creates and deletes). The watch echo of each of the store's own moves is not announced
   * again: while the move runs, the first `moved` event from its source (to any path, since the server may
   * pick the name); after it settles, the first one with its old and final path, for 10 s. Each move expects
   * one echo, so repeated moves of one pair each consume their own. Accepted bound: an echo later than 10 s
   * is announced again, and an external move from the same source while the move runs, or with the same pair
   * within the window, is taken for the echo. A move that fails stops expecting its echo at once and
   * announces the moves it had taken for it. Any other `moved` event is announced. A move whose adapter
   * answered with a path outside the root is announced at the path the store placed it at, and the bad answer
   * goes to `onError`. It runs before subscribers are notified, so path-keyed state can follow the move in
   * the same render. A listener that throws is reported to `onError` and does not stop the others. Returns
   * the unsubscribe.
   */
  onMove: (listener: (from: string, to: string) => void) => () => void;
  /** Stops watching and notifying, and forgets every listener. The store must not be used afterwards. */
  dispose: () => void;
}

/**
 * Options of `createTreeStore`.
 *
 * @example
 * ```ts
 * const options: TreeStoreOptions = {
 *   fetchDepth: 2,
 *   root: 'workspace',
 *   onError: (error) => console.error(error),
 * };
 * ```
 */
export interface TreeStoreOptions {
  /** How many levels each listing request asks for (`adapter.list`'s `depth`). Default 2. */
  fetchDepth?: number;
  /**
   * The folder the store shows. `loadFolder` rejects paths outside it with `invalid`, and change events
   * outside it are ignored. Default `''`, the whole file system.
   */
  root?: string;
  /** Receives every load failure, a bad adapter answer and an error thrown by an `onMove` listener. */
  onError?: (error: FsError) => void;
}

const unsupported = (): FsError => new FsError('invalid', 'operation not supported');
const notFound = (path: string): FsError => new FsError('not_found', `not found: ${path}`, { path });
const invalidName = (name: string, problem: NameProblem, path: string): FsError =>
  new FsError(problem === 'duplicate' ? 'conflict' : 'invalid', `invalid name "${name}": ${problem}`, {
    path,
  });

function assertNotRoot(path: string, operation: string): void {
  if (path === '') throw new FsError('invalid', `cannot ${operation} the root`, { path });
}

const isLoaded = (tree: TreeData, path: string): boolean => statusOf(tree, path) === 'loaded';

const placedAt = (answered: Entry, path: string): Entry => ({ ...answered, path, name: basename(path) });

function withStatus(tree: TreeData, path: string, status: FolderStatus): TreeData {
  return applyBatch(tree, [{ kind: 'status', path, status }]);
}

function idleStatusFor(tree: TreeData, discardedLoads: string[]): TreeOp[] {
  return discardedLoads
    .filter((path) => statusOf(tree, path) === 'loading')
    .map((path): TreeOp => ({ kind: 'status', path, status: 'idle' }));
}

const knownEmptyFolder = (path: string): TreeOp => ({ kind: 'listing', folder: path, depth: 1, entries: [] });

interface LiftedSubtree {
  entry: Entry | undefined;
  nodes: FolderNode[];
}

function liftSubtree(tree: TreeData, path: string): LiftedSubtree {
  const nodes: FolderNode[] = [];
  for (const node of tree.folders.values()) if (isSameOrDescendant(node.path, path)) nodes.push(node);
  return { entry: entryAt(tree, path), nodes };
}

function knowsChildrenOf(tree: TreeData, path: string): boolean {
  const node = tree.folders.get(path);
  return node !== undefined && (node.status === 'loaded' || node.children.size > 0);
}

function knownListingThatLacks(tree: TreeData, path: string, stopAt: string): string | undefined {
  for (let ancestorOrSelf = path; ancestorOrSelf !== stopAt && ancestorOrSelf !== '';) {
    const parent = parentPath(ancestorOrSelf);
    if (knowsChildrenOf(tree, parent)) return entryAt(tree, ancestorOrSelf) ? undefined : parent;
    ancestorOrSelf = parent;
  }
  return undefined;
}

function restoreSubtree(tree: TreeData, lifted: LiftedSubtree, path: string): TreeData {
  const nothingLifted = !lifted.entry && lifted.nodes.length === 0;
  if (nothingLifted || !knowsChildrenOf(tree, parentPath(path))) return tree;
  const ops: TreeOp[] = lifted.entry ? [{ kind: 'upsert', entry: lifted.entry }] : [];
  for (const node of lifted.nodes) {
    for (const entry of node.children.values()) ops.push({ kind: 'upsert', entry });
    ops.push({ kind: 'status', path: node.path, status: node.status });
  }
  return applyBatch(tree, ops);
}

type NormalizedChange =
  | { type: 'created' | 'updated' | 'deleted'; path: string; external: boolean; entry?: Entry }
  | { type: 'moved'; from: string; path: string; external: boolean; entry?: Entry };

type EntryChangeEvent = ChangeEvent & { type: Exclude<ChangeEvent['type'], 'resync'> };

const isEntryChange = (event: ChangeEvent): event is EntryChangeEvent => event.type !== 'resync';

function trustedEntry(event: EntryChangeEvent, path: string, root: string): Entry | undefined {
  const { entry } = event;
  if (event.type === 'deleted' || typeof entry !== 'object' || entry === null) return undefined;
  const fits =
    typeof entry.path === 'string' &&
    normalizedOrUndefined(entry.path) === path &&
    path !== root &&
    entry.name === basename(path) &&
    (entry.kind === 'file' || entry.kind === 'directory');
  if (!fits) return undefined;
  return entry.path === path ? entry : { ...entry, path };
}

function normalizeChange(event: EntryChangeEvent, root: string): NormalizedChange | undefined {
  let path: string;
  let oldPath: string | undefined;
  try {
    path = normalizePath(event.path);
    oldPath = event.oldPath === undefined ? undefined : normalizePath(event.oldPath);
  } catch {
    return undefined;
  }
  const inRoot = (candidate: string): boolean => isSameOrDescendant(candidate, root);
  const external = event.actor !== undefined && event.actor !== 'user';
  const entry = trustedEntry(event, path, root);
  const withEntry = entry ? { entry } : {};
  if (event.type !== 'moved') {
    return inRoot(path) ? { type: event.type, path, external, ...withEntry } : undefined;
  }
  if (oldPath === undefined || !inRoot(oldPath)) {
    return inRoot(path) ? { type: 'created', path, external, ...withEntry } : undefined;
  }
  if (!inRoot(path)) return { type: 'deleted', path: oldPath, external };
  if (isSameOrDescendant(path, oldPath)) return undefined;
  return { type: 'moved', from: oldPath, path, external, ...withEntry };
}

interface FollowUpLoads {
  reloadParents: Set<string>;
  refetchRequested: Set<string>;
  reissued: Set<string>;
  resync: boolean;
}

interface Mutation<T> {
  pendingPaths: string[];
  reloadAfter: string[];
  optimistic(tree: TreeData): TreeData;
  rollback(tree: TreeData): TreeData;
  request(): Promise<T>;
  confirm(tree: TreeData, result: T): TreeData;
  afterConfirm?: (result: T) => void;
  afterRollback?: () => void;
}

class ObservableTreeStore implements TreeStore {
  readonly #adapter: FileSystemAdapter;
  readonly #options: TreeStoreOptions;
  readonly #fetchDepth: number;
  readonly #root: string;

  #tree: TreeData = emptyTree();
  #errors: ReadonlyMap<string, FsError> = new Map();
  #changed: ReadonlySet<string> = new Set();
  readonly #changedBelow: ChangedBelowCounts;
  #latestExternalChange: TreeSnapshot['latestExternalChange'] = null;
  readonly #pendingCount = new Map<string, number>();
  #pending: ReadonlySet<string> = new Set();
  #version = 0;
  #snapshot: TreeSnapshot;
  readonly #listeners = new Set<() => void>();
  readonly #moveListeners = new Set<(from: string, to: string) => void>();
  readonly #ownMoveEchoes = new OwnMoveEchoes();
  #notifyScheduled = false;
  #disposed = false;
  #unwatch: (() => void) | undefined;

  readonly #listings = new ListingRequests();

  #resyncRunning = false;
  #resyncRequestedAgain = false;

  constructor(adapter: FileSystemAdapter, options: TreeStoreOptions) {
    this.#adapter = adapter;
    this.#options = options;
    this.#fetchDepth = options.fetchDepth ?? 2;
    this.#root = normalizePath(options.root ?? '');
    this.#changedBelow = new ChangedBelowCounts(this.#root);
    this.#snapshot = this.#takeSnapshot();
  }

  getSnapshot = (): TreeSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (!this.#unwatch && !this.#disposed) this.#unwatch = this.#adapter.watch?.(this.applyChanges);
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  loadFolder = async (path: string, opts?: { force?: boolean }): Promise<void> => {
    const normalized = normalizePath(path);
    if (!isSameOrDescendant(normalized, this.#root)) {
      throw new FsError('invalid', `outside the store root: ${normalized}`, { path: normalized });
    }
    return this.#loadUntilNoNewerLoad(normalized, opts?.force === true);
  };

  create = async (parent: string, name: string, kind: EntryKind): Promise<Entry> => {
    if (!this.#adapter.create) throw unsupported();
    const parentDir = normalizePath(parent);
    await this.#ensureLoaded(parentDir);
    const problem = validateName(name, this.#siblingNames(parentDir));
    if (problem) throw invalidName(name, problem, parentDir);
    const path = joinPath(parentDir, name);
    const entry: Entry = {
      path,
      name: basename(path),
      kind,
      mtimeMs: Date.now(),
      ...(kind === 'file' ? { size: 0 } : {}),
    };
    const placeEntry: TreeOp = { kind: 'upsert', entry };
    return this.#mutate({
      pendingPaths: [path],
      reloadAfter: [parentDir],
      optimistic: (tree) =>
        applyBatch(tree, kind === 'directory' ? [placeEntry, knownEmptyFolder(path)] : [placeEntry]),
      rollback: (tree) => (entryAt(tree, path) === entry ? removeSubtree(tree, path) : tree),
      request: async () => {
        const answered = await this.#adapter.create!(path, kind);
        return this.#entryInsideRoot(answered, path) ?? placedAt(answered, path);
      },
      confirm: upsertEntry,
    });
  };

  rename = async (path: string, newName: string): Promise<Entry> => {
    if (!this.#adapter.move) throw unsupported();
    const source = normalizePath(path);
    assertNotRoot(source, 'rename');
    const entry = entryAt(this.#tree, source);
    if (!entry) throw notFound(source);
    if (newName.normalize('NFC') === entry.name) return entry;
    const parent = parentPath(source);
    const problem = validateName(newName, this.#siblingNames(parent, source));
    if (problem) throw invalidName(newName, problem, source);
    return this.#transfer('move', source, joinPath(parent, newName));
  };

  move = async (path: string, toDir: string, opts?: TreeTransferOptions): Promise<Entry> => {
    if (!this.#adapter.move) throw unsupported();
    const source = normalizePath(path);
    assertNotRoot(source, 'move');
    const destinationDir = normalizePath(toDir);
    const name = opts?.name ?? basename(source);
    const problem = validateTransfer('move', source, destinationDir);
    if (problem === 'into_self') {
      throw new FsError('invalid', `cannot move ${source} into itself`, { path: source });
    }
    if (problem === 'noop' && name === basename(source)) {
      const entry = entryAt(this.#tree, source);
      if (!entry) throw notFound(source);
      return entry;
    }
    await this.#ensureLoaded(destinationDir);
    if (opts?.name !== undefined) this.#assertNameIsFree(name, destinationDir, source, opts);
    return this.#transfer('move', source, joinPath(destinationDir, name), opts);
  };

  copy = async (path: string, toDir: string, opts?: TreeTransferOptions): Promise<Entry> => {
    if (!this.#adapter.copy) throw unsupported();
    const source = normalizePath(path);
    const destinationDir = normalizePath(toDir);
    if (validateTransfer('copy', source, destinationDir) === 'into_self') {
      throw new FsError('invalid', `cannot copy ${source} into itself`, { path: source });
    }
    await this.#ensureLoaded(destinationDir);
    if (opts?.name !== undefined) this.#assertNameIsFree(opts.name, destinationDir, undefined, opts);
    const name =
      opts?.name ??
      (opts?.overwrite ? basename(source) : uniqueName(basename(source), this.#siblingNames(destinationDir)));
    return this.#transfer('copy', source, joinPath(destinationDir, name), opts);
  };

  duplicate = (path: string): Promise<Entry> => {
    const source = normalizePath(path);
    return this.copy(source, parentPath(source));
  };

  remove = async (path: string): Promise<void> => {
    if (!this.#adapter.delete) throw unsupported();
    const target = normalizePath(path);
    assertNotRoot(target, 'remove');
    this.#tree = applyBatch(
      this.#tree,
      idleStatusFor(this.#tree, this.#discardLoadsAndErrorsAtOrBelow(target)),
    );
    const lifted = liftSubtree(this.#tree, target);
    this.#dropChangedAtOrBelow(target);
    await this.#mutate({
      pendingPaths: [target],
      reloadAfter: [parentPath(target)],
      optimistic: (tree) => removeSubtree(tree, target),
      rollback: (tree) => restoreSubtree(tree, lifted, target),
      request: () => this.#adapter.delete!(target),
      confirm: (tree) => tree,
    });
  };

  applyChanges = (events: ChangeEvent[]): void => {
    if (this.#disposed || events.length === 0) return;
    const pending = new PendingTreeOps(this.#tree);
    const marks = new ChangeMarks(this.#changed, this.#changedBelow);
    const followUp: FollowUpLoads = {
      reloadParents: new Set(),
      refetchRequested: new Set(),
      reissued: new Set(),
      resync: false,
    };
    const errorsBefore = this.#errors;
    const moves: Array<{ from: string; to: string }> = [];
    try {
      for (const event of events) {
        if (!isEntryChange(event)) {
          followUp.resync = true;
          continue;
        }
        const change = normalizeChange(event, this.#root);
        if (!change) continue;
        const isOwnMoveEcho =
          change.type === 'moved' && this.#ownMoveEchoes.consume(change.from, change.path);
        if (change.type === 'moved' && !isOwnMoveEcho) moves.push({ from: change.from, to: change.path });
        const changeToApply = isOwnMoveEcho ? { ...change, entry: undefined } : change;
        this.#applyChange(pending, marks, changeToApply, followUp);
      }
    } catch (error) {
      marks.discard();
      throw error;
    }
    const tree = pending.finish();
    this.#latestExternalChange = marks.latestExternalChangeAfter(this.#latestExternalChange);
    if (
      tree !== this.#tree ||
      marks.marks !== this.#changed ||
      this.#errors !== errorsBefore ||
      marks.markedExternally
    ) {
      this.#tree = tree;
      this.#changed = marks.marks;
      this.#commit();
    }
    try {
      for (const { from, to } of moves) this.#announceMove(from, to);
    } finally {
      this.#startFollowUpLoads(followUp);
    }
  };

  markSeen = (path: string): void => {
    const marks = new ChangeMarks(this.#changed, this.#changedBelow);
    if (!marks.unmark(normalizePath(path))) return;
    this.#changed = marks.marks;
    this.#commit();
  };

  onMove = (listener: (from: string, to: string) => void): (() => void) => {
    this.#moveListeners.add(listener);
    return () => void this.#moveListeners.delete(listener);
  };

  dispose = (): void => {
    this.#disposed = true;
    this.#unwatch?.();
    this.#listeners.clear();
    this.#moveListeners.clear();
    this.#ownMoveEchoes.dispose();
  };

  #stopAwaitingEchoOfFailedMove(own: OwnMove): void {
    for (const to of this.#ownMoveEchoes.stopAwaitingFailed(own)) this.#announceMove(own.from, to);
  }

  #announceMove(from: string, to: string): void {
    for (const listener of [...this.#moveListeners]) {
      try {
        listener(from, to);
      } catch (error) {
        this.#options.onError?.(toFsError(error));
      }
    }
  }

  #entryInsideRoot(answered: Entry, placedAt: string): Entry | undefined {
    const path = normalizedOrUndefined(answered.path);
    if (path !== undefined && path !== this.#root && isSameOrDescendant(path, this.#root)) {
      return path === answered.path ? answered : { ...answered, path, name: basename(path) };
    }
    this.#options.onError?.(
      new FsError(
        'invalid',
        `The adapter answered "${answered.path}" for ${placedAt}, which is outside the store root "${this.#root}"; ` +
          `the tree keeps ${placedAt} until its folder reloads. Make the adapter return paths below the root.`,
        { path: placedAt },
      ),
    );
    return undefined;
  }

  #takeSnapshot(): TreeSnapshot {
    return {
      version: this.#version,
      tree: this.#tree,
      errors: this.#errors,
      pending: this.#pending,
      changed: this.#changed,
      changedBelow: this.#changedBelow.shareFolders(),
      latestExternalChange: this.#latestExternalChange,
    };
  }

  #commit(): void {
    this.#version++;
    this.#snapshot = this.#takeSnapshot();
    if (this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      if (!this.#disposed) for (const listener of [...this.#listeners]) listener();
    });
  }

  #trackPending(paths: string[], by: 1 | -1): void {
    for (const path of paths) {
      const count = (this.#pendingCount.get(path) ?? 0) + by;
      if (count > 0) this.#pendingCount.set(path, count);
      else this.#pendingCount.delete(path);
    }
    this.#pending = new Set(this.#pendingCount.keys());
  }

  #discardLoadsAndErrorsAtOrBelow(path: string): string[] {
    const discarded = this.#listings.discardAtOrBelow(path);
    if ([...this.#errors.keys()].some((errorPath) => isSameOrDescendant(errorPath, path))) {
      this.#errors = new Map([...this.#errors].filter(([errorPath]) => !isSameOrDescendant(errorPath, path)));
    }
    return discarded;
  }

  #fail(path: string, error: FsError): void {
    this.#tree = withStatus(this.#tree, path, 'error');
    this.#errors = new Map(this.#errors).set(path, error);
    this.#commit();
    this.#options.onError?.(error);
  }

  #clearError(path: string): void {
    if (!this.#errors.has(path)) return;
    const next = new Map(this.#errors);
    next.delete(path);
    this.#errors = next;
  }

  #isCurrentRequest(path: string, requestId: number): boolean {
    return !this.#disposed && this.#listings.isCurrent(path, requestId);
  }

  async #fetchFolder(path: string, explicit: boolean): Promise<void> {
    const requestId = this.#listings.begin(path, explicit);
    if (!isLoaded(this.#tree, path)) {
      this.#tree = withStatus(this.#tree, path, 'loading');
      this.#commit();
    }
    try {
      const entries = await this.#adapter.list(path, { depth: this.#fetchDepth });
      if (this.#isCurrentRequest(path, requestId)) this.#applyListing(path, requestId, entries);
    } catch (error) {
      if (this.#isCurrentRequest(path, requestId)) this.#fail(path, toFsError(error));
    } finally {
      this.#listings.end(path, requestId);
      this.#startTrailingReloadIfDue(path, requestId);
    }
  }

  #startTrailingReloadIfDue(path: string, requestId: number): void {
    const due = this.#listings.takeDueTrailingReload(path, requestId);
    if (!due || this.#disposed || !isLoaded(this.#tree, path)) return;
    this.#listings.coalesceTrailingReload(path, this.#load(path, true, false));
  }

  #applyListing(path: string, requestId: number, entries: Entry[]): void {
    const lackingListing = knownListingThatLacks(this.#tree, path, this.#root);
    if (lackingListing !== undefined && !this.#listings.isRequestedByCaller(path)) {
      this.#discardGhostListing(path);
      return;
    }
    this.#tree = mergeListing(this.#tree, path, this.#fetchDepth, entries);
    this.#tree = applyBatch(this.#tree, this.#discardBackgroundLoadsLackedBelow(path));
    this.#clearError(path);
    this.#commit();
    if (lackingListing !== undefined) this.#reloadOutdatedListingOnce(lackingListing, requestId);
  }

  #discardGhostListing(path: string): void {
    if (statusOf(this.#tree, path) !== 'loading') return;
    this.#tree = withStatus(this.#tree, path, 'idle');
    this.#commit();
  }

  #discardBackgroundLoadsLackedBelow(path: string): TreeOp[] {
    const ops: TreeOp[] = [];
    for (const loading of this.#listings.liveInFlightPaths()) {
      const isBackgroundLoadBelow =
        loading !== path && !this.#listings.isRequestedByCaller(loading) && isSameOrDescendant(loading, path);
      if (isBackgroundLoadBelow && knownListingThatLacks(this.#tree, loading, path) !== undefined) {
        ops.push(...idleStatusFor(this.#tree, this.#discardLoadsAndErrorsAtOrBelow(loading)));
      }
    }
    return ops;
  }

  #reloadOutdatedListingOnce(listing: string, requestId: number): void {
    if (this.#listings.lastRequestedBefore(listing, requestId)) void this.#load(listing, true, false);
  }

  async #loadUntilNoNewerLoad(path: string, force: boolean): Promise<void> {
    let load = this.#load(path, force, true);
    for (;;) {
      await load;
      const newer = this.#listings.loadToWaitFor(path);
      if (newer === undefined) return;
      load = newer;
    }
  }

  #load(path: string, force: boolean, explicit: boolean): Promise<void> {
    if (!force) {
      if (isLoaded(this.#tree, path)) return Promise.resolve();
      const running = this.#listings.joinRunningLoad(path, explicit);
      if (running) return running;
    }
    return this.#listings.trackLoad(path, this.#fetchFolder(path, explicit));
  }

  async #ensureLoaded(dir: string): Promise<void> {
    await this.loadFolder(dir);
    if (!isLoaded(this.#tree, dir)) {
      throw this.#errors.get(dir) ?? new FsError('unknown', `cannot load ${dir}`, { path: dir });
    }
  }

  async #reloadFolders(paths: string[]): Promise<void> {
    await Promise.all([...new Set(paths)].map((path) => this.#load(path, true, false)));
  }

  async #mutate<T>(mutation: Mutation<T>): Promise<T> {
    this.#tree = mutation.optimistic(this.#tree);
    this.#trackPending(mutation.pendingPaths, 1);
    this.#commit();
    let result: T;
    try {
      result = await mutation.request();
    } catch (error) {
      this.#tree = mutation.rollback(this.#tree);
      this.#trackPending(mutation.pendingPaths, -1);
      this.#commit();
      mutation.afterRollback?.();
      await this.#reloadFolders(mutation.reloadAfter);
      throw toFsError(error);
    }
    this.#tree = mutation.confirm(this.#tree, result);
    this.#trackPending(mutation.pendingPaths, -1);
    this.#commit();
    try {
      mutation.afterConfirm?.(result);
    } finally {
      await this.#reloadFolders(mutation.reloadAfter);
    }
    return result;
  }

  #dropChangedAtOrBelow(path: string): void {
    const marks = new ChangeMarks(this.#changed, this.#changedBelow);
    marks.unmarkAtOrBelow(path);
    this.#changed = marks.marks;
  }

  #assertNameIsFree(
    name: string,
    dir: string,
    movingFrom: string | undefined,
    opts: TreeTransferOptions,
  ): void {
    const taken = this.#siblingNames(dir, movingFrom);
    if (opts.overwrite) {
      const sameName = (sibling: string): boolean => validateName(name, new Set([sibling])) === 'duplicate';
      const replaced = taken.has(name) ? name : [...taken].find(sameName);
      if (replaced !== undefined) taken.delete(replaced);
    }
    const problem = validateName(name, taken);
    if (problem) throw invalidName(name, problem, joinPath(dir, name));
  }

  #siblingNames(parent: string, except?: string): Set<string> {
    const names = new Set<string>();
    for (const [name, entry] of this.#tree.folders.get(parent)?.children ?? []) {
      if (entry.path !== except) names.add(name);
    }
    return names;
  }

  #checkTransfer(op: 'move' | 'copy', from: string, to: string, opts?: TreeTransferOptions): Entry {
    const source = entryAt(this.#tree, from);
    if (!source) throw notFound(from);
    if (isSameOrDescendant(from, to)) {
      throw new FsError('invalid', `cannot ${op} ${from} to ${to}`, { path: to });
    }
    if (entryAt(this.#tree, to) && !opts?.overwrite) {
      throw new FsError('conflict', `already exists: ${to}`, { path: to });
    }
    const adapterSupportsIt =
      op === 'move' ? this.#adapter.move !== undefined : this.#adapter.copy !== undefined;
    if (!adapterSupportsIt) throw unsupported();
    return source;
  }

  async #transfer(op: 'move' | 'copy', from: string, to: string, opts?: TreeTransferOptions): Promise<Entry> {
    const source = this.#checkTransfer(op, from, to, opts);
    const sourceStatusResets =
      op === 'move' ? idleStatusFor(this.#tree, this.#discardLoadsAndErrorsAtOrBelow(from)) : [];
    this.#tree = applyBatch(this.#tree, [
      ...sourceStatusResets,
      ...idleStatusFor(this.#tree, this.#discardLoadsAndErrorsAtOrBelow(to)),
    ]);
    const liftedSource = liftSubtree(this.#tree, from);
    const replacedDestination = liftSubtree(this.#tree, to);
    let placedAtDestination: Entry | undefined;
    const own = op === 'move' ? this.#ownMoveEchoes.expect(from, to) : undefined;
    const committed = this.#mutate({
      pendingPaths: [from, to],
      reloadAfter: [parentPath(from), parentPath(to)],
      optimistic: (tree) => {
        const next =
          op === 'move'
            ? moveSubtree(tree, from, to)
            : upsertEntry(removeSubtree(tree, to), { ...source, path: to, name: basename(to) });
        placedAtDestination = entryAt(next, to);
        return next;
      },
      rollback: (tree) => {
        let next = tree;
        const destinationStillOurs = entryAt(next, to) === placedAtDestination;
        if (op === 'move' && destinationStillOurs) next = moveSubtree(next, to, from);
        else if (destinationStillOurs) next = removeSubtree(next, to);
        if (op === 'move' && !entryAt(next, from)) next = restoreSubtree(next, liftedSource, from);
        return restoreSubtree(next, replacedDestination, to);
      },
      request: async () => {
        const adapterOptions = opts?.overwrite ? { overwrite: true } : undefined;
        const answered = await (op === 'move'
          ? this.#adapter.move!(from, to, adapterOptions)
          : this.#adapter.copy!(from, to, adapterOptions));
        return this.#entryInsideRoot(answered, to) ?? placedAt(answered, to);
      },
      confirm: upsertEntry,
      afterConfirm: (moved) => {
        if (!own) return;
        this.#ownMoveEchoes.landedAt(own, moved.path);
        this.#announceMove(from, moved.path);
      },
      afterRollback: () => {
        if (own) this.#stopAwaitingEchoOfFailedMove(own);
      },
    });
    try {
      return await committed;
    } finally {
      if (own) this.#ownMoveEchoes.stopAwaitingSoon(own);
    }
  }

  async #resync(): Promise<void> {
    if (this.#resyncRunning) {
      this.#resyncRequestedAgain = true;
      return;
    }
    this.#resyncRunning = true;
    try {
      do {
        this.#resyncRequestedAgain = false;
        await this.#reloadFolders(this.#loadedOrLoadingFolders());
      } while (this.#resyncRequestedAgain && !this.#disposed);
    } finally {
      this.#resyncRunning = false;
    }
  }

  #loadedOrLoadingFolders(): string[] {
    const paths: string[] = [];
    for (const node of this.#tree.folders.values()) {
      if (node.status === 'loaded' || node.status === 'loading') paths.push(node.path);
    }
    return paths;
  }

  #applyChange(
    pending: PendingTreeOps,
    marks: ChangeMarks,
    change: NormalizedChange,
    followUp: FollowUpLoads,
  ): void {
    switch (change.type) {
      case 'deleted':
        return this.#applyDeleted(pending, marks, change.path, followUp);
      case 'moved':
        return this.#applyMoved(pending, marks, change, followUp);
      case 'created':
      case 'updated':
        return this.#applyCreatedOrUpdated(pending, marks, change, followUp);
    }
  }

  #applyDeleted(pending: PendingTreeOps, marks: ChangeMarks, path: string, followUp: FollowUpLoads): void {
    this.#reissueInFlightListingsAbove(path, followUp);
    pending.queue(
      ...idleStatusFor(pending.treeWithoutPendingOps, this.#discardLoadsAndErrorsAtOrBelow(path)),
      { kind: 'remove', path },
    );
    pending.markTouchedByPendingOps(path);
    marks.unmarkAtOrBelow(path);
  }

  #applyMoved(
    pending: PendingTreeOps,
    marks: ChangeMarks,
    change: Extract<NormalizedChange, { type: 'moved' }>,
    followUp: FollowUpLoads,
  ): void {
    const { from, path: to } = change;
    this.#reissueInFlightListingsAbove(from, followUp);
    this.#reissueInFlightListingsAbove(to, followUp);
    const parent = parentPath(to);
    pending.queue(
      ...idleStatusFor(pending.treeWithoutPendingOps, this.#discardLoadsAndErrorsAtOrBelow(from)),
      ...idleStatusFor(pending.treeWithoutPendingOps, this.#discardLoadsAndErrorsAtOrBelow(to)),
    );
    const hadEntry = entryAt(pending.treeAfterFlushingOpsTouching(from), from) !== undefined;
    const parentLoaded = isLoaded(pending.treeAfterFlushingOpsTouching(parent), parent);
    const placed = parentLoaded
      ? this.#entryToPlace(change, pending.treeAfterFlushingOpsTouching(to))
      : undefined;
    const movesOutOfView = hadEntry && !parentLoaded;
    pending.queue(movesOutOfView ? { kind: 'remove', path: from } : { kind: 'move', from, to });
    if (placed) pending.queue({ kind: 'upsert', entry: placed });
    pending.markTouchedByPendingOps(from, to);
    const entryArrivesWithParentListing = !hadEntry && parentLoaded && !placed;
    if (entryArrivesWithParentListing) followUp.reloadParents.add(parent);
    for (const marked of marks.unmarkAtOrBelow(from)) marks.mark(remapPrefix(marked, from, to));
    if (change.external && parentLoaded) marks.markExternal(to);
  }

  #reissueInFlightListingsAbove(path: string, followUp: FollowUpLoads): void {
    let ancestor = path;
    for (
      let levelsUp = 1;
      levelsUp <= this.#fetchDepth && ancestor !== this.#root && ancestor !== '';
      levelsUp++
    ) {
      ancestor = parentPath(ancestor);
      this.#requestInFlightListingAgainOnce(ancestor, followUp);
    }
  }

  #requestInFlightListingAgainOnce(folder: string, followUp: FollowUpLoads): void {
    const requestedBy = this.#listings.markReissue(folder);
    if (requestedBy === undefined) return;
    followUp.reissued.add(folder);
    if (requestedBy === 'caller') followUp.refetchRequested.add(folder);
    else followUp.reloadParents.add(folder);
  }

  #applyCreatedOrUpdated(
    pending: PendingTreeOps,
    marks: ChangeMarks,
    change: NormalizedChange,
    followUp: FollowUpLoads,
  ): void {
    const { path } = change;
    this.#reissueInFlightListingsAbove(path, followUp);
    if (change.type === 'created') {
      for (const requested of this.#listings.callerRequestsAtOrBelow(path)) {
        followUp.refetchRequested.add(requested);
      }
      pending.queue(
        ...idleStatusFor(pending.treeWithoutPendingOps, this.#discardLoadsAndErrorsAtOrBelow(path)),
      );
    }
    const parent = parentPath(path);
    const tree = pending.treeAfterFlushingOpsTouching(path);
    if (!isLoaded(tree, parent)) return;
    const placed = this.#entryToPlace(change, tree);
    if (placed) {
      pending.queue({ kind: 'upsert', entry: placed });
      pending.markTouchedByPendingOps(path);
    } else if (this.#listings.isInFlight(parent)) this.#requestInFlightListingAgainOnce(parent, followUp);
    else followUp.reloadParents.add(parent);
    if (change.external) marks.markExternal(path);
  }

  #entryToPlace(change: NormalizedChange, tree: TreeData): Entry | undefined {
    const { entry, path } = change;
    const mutationInFlight =
      this.#pending.has(path) || (change.type === 'moved' && this.#pending.has(change.from));
    if (!entry || mutationInFlight) return undefined;
    const replacesALoadedFolder =
      change.type !== 'updated' && entry.kind === 'directory' && tree.folders.has(path);
    return replacesALoadedFolder ? undefined : entry;
  }

  #startFollowUpLoads(followUp: FollowUpLoads): void {
    this.#listings.coalesceReissues(followUp.reissued, () => this.#startFollowUpRequests(followUp));
  }

  #startFollowUpRequests(followUp: FollowUpLoads): void {
    if (followUp.resync) void this.#resync();
    else {
      for (const parent of followUp.reloadParents) {
        if (isLoaded(this.#tree, parent)) void this.#load(parent, true, false);
      }
    }
    for (const requested of followUp.refetchRequested) void this.#load(requested, true, true);
  }
}

/**
 * The tree state for one adapter: folder listings, load errors, pending mutations and paths changed by
 * others, as an external store for `useSyncExternalStore`. Creating one has no side effects; the first
 * `subscribe` arms `adapter.watch`, so it is safe during render and on the server.
 *
 * Loading: each listing request gets an increasing id, and a response is applied only while its id is still
 * the folder's in-flight request, so a newer request, a removal or a move discards it. A listing the caller
 * asked for is applied as is (the server's answer is the truth). A background listing of a folder that a
 * known ancestor listing lacks is dropped instead, so a removed folder never comes back; that ancestor is
 * reloaded once, shared by every load under it that started before the reload.
 *
 * Mutations are optimistic. A failure applies the inverse operation to the current tree, never a stored copy,
 * so listings that landed in the meantime survive; either way the affected parents are reloaded, so a partial
 * server-side failure heals itself.
 *
 * Live changes: `applyChanges` folds a batch into one tree update. A recreated path drops its in-flight
 * listings (listings the caller asked for are requested again). A change inside a loaded folder that carries
 * its `entry` places it there without a request; the entry is server data, so one whose path or name does not
 * match the event, whose kind is unknown, whose path has a store mutation in flight, or that would replace a
 * loaded folder (a recreated or overwritten directory) is ignored, and so is the entry of an own move's echo.
 * Any other change inside a loaded folder reloads that folder (the listing replaces entries wholesale, so a
 * file that became a folder loses stale children). Every change requests again every listing in flight up to
 * `fetchDepth` levels above the changed path, or above either end of a move (a stale answer could bring a
 * deleted entry back, drop a moved one, or undo a fresher listing of the changed folder; a listing farther up
 * cannot contain the path), and a `resync` event reloads every loaded folder. A listing in flight is
 * replaced this way (by a reload or a re-issue) only once: further changes during its flight queue one
 * trailing background reload of the folder, started when it lands, so churn cannot keep a folder loading; a
 * ghost or missing entry lasts at most one listing round trip. At most one resync pass runs; resyncs that
 * arrive meanwhile fold into one follow-up pass.
 * `loadFolder` waits for the newest load of its folder except a trailing reload, so a load requested again
 * settles with the answer that is applied, not the dropped one.
 *
 * @example
 * ```ts
 * const store = createTreeStore(createMemoryAdapter({ files: { 'src/a.ts': '' } }), { fetchDepth: 2 });
 * const unsubscribe = store.subscribe(() => render(store.getSnapshot()));
 * await store.loadFolder('');
 * await store.rename('src/a.ts', 'b.ts');
 * ```
 */
export function createTreeStore(adapter: FileSystemAdapter, opts: TreeStoreOptions = {}): TreeStore {
  return new ObservableTreeStore(adapter, opts);
}
