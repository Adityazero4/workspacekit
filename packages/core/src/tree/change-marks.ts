import { isSameOrDescendant, parentPath } from '../path';
import type { TreeSnapshot } from './store';

/**
 * How many marked paths lie below each folder, kept for the store's whole life so a mark or an unmark costs
 * O(depth). The folders strictly inside the root with a mark below them form `TreeSnapshot.changedBelow`:
 * that set is copied only when a folder joins or leaves it, and at most once per shared snapshot.
 *
 * @example
 * ```ts
 * const changedBelow = new ChangedBelowCounts('');
 * changedBelow.count('docs/a.txt', 1);
 * changedBelow.shareFolders(); // Set { 'docs' }
 * ```
 */
export class ChangedBelowCounts {
  readonly #root: string;
  readonly #counts = new Map<string, number>();
  #folders = new Set<string>();
  #foldersShared = false;

  constructor(root: string) {
    this.#root = root;
  }

  /** Whether a marked path lies below `folder`; also answers for the root and the folders above it. */
  hasMarksBelow(folder: string): boolean {
    return this.#counts.has(folder);
  }

  /** The folders inside the root with a mark below them. The set returned is never changed afterwards. */
  shareFolders(): ReadonlySet<string> {
    this.#foldersShared = true;
    return this.#folders;
  }

  /** Adds `by` to the count of every folder above `path`. */
  count(path: string, by: 1 | -1): void {
    let insideRoot = true;
    for (let folder = path; folder !== '';) {
      folder = parentPath(folder);
      insideRoot &&= folder !== this.#root;
      const count = (this.#counts.get(folder) ?? 0) + by;
      if (count > 0) this.#counts.set(folder, count);
      else this.#counts.delete(folder);
      const hasMarksBelow = count > 0;
      if (insideRoot && hasMarksBelow !== this.#folders.has(folder)) {
        this.#setMembership(folder, hasMarksBelow);
      }
    }
  }

  #setMembership(folder: string, member: boolean): void {
    if (this.#foldersShared) {
      this.#folders = new Set(this.#folders);
      this.#foldersShared = false;
    }
    if (member) this.#folders.add(folder);
    else this.#folders.delete(folder);
  }
}

/**
 * The `changed` set of one `applyChanges` batch, or of one `markSeen` or delete. It is copied on the first
 * write, so a batch that marks nothing keeps the snapshot's set, and every write keeps `changedBelow` in
 * step; `discard` takes those count changes back when the batch is abandoned.
 *
 * @example
 * ```ts
 * const marks = new ChangeMarks(snapshot.changed, changedBelow);
 * marks.markExternal('docs/a.txt');
 * marks.unmarkAtOrBelow('docs');
 * ```
 */
export class ChangeMarks {
  #marks: ReadonlySet<string>;
  readonly #changedBelow: ChangedBelowCounts;
  readonly #counted: Array<{ path: string; by: 1 | -1 }> = [];
  #copied = false;
  #latestExternal: string | null = null;
  #externalCount = 0;

  constructor(marks: ReadonlySet<string>, changedBelow: ChangedBelowCounts) {
    this.#marks = marks;
    this.#changedBelow = changedBelow;
  }

  /** The marks so far: the set passed in until the first change, a copy afterwards. */
  get marks(): ReadonlySet<string> {
    return this.#marks;
  }

  /** Whether `markExternal` was called, even for a path already marked. */
  get markedExternally(): boolean {
    return this.#externalCount > 0;
  }

  /** `previous` advanced by one per `markExternal` call, at the last path marked; `previous` when none. */
  latestExternalChangeAfter(
    previous: TreeSnapshot['latestExternalChange'],
  ): TreeSnapshot['latestExternalChange'] {
    if (this.#latestExternal === null) return previous;
    return { path: this.#latestExternal, sequence: (previous?.sequence ?? 0) + this.#externalCount };
  }

  /** Marks `path` as changed by someone other than the user and records it as the latest such change. */
  markExternal(path: string): void {
    this.#latestExternal = path;
    this.#externalCount++;
    this.mark(path);
  }

  /** Marks `path` without recording it as the latest external change, such as a mark that followed a move. */
  mark(path: string): void {
    if (this.#marks.has(path)) return;
    this.#writable().add(path);
    this.#count(path, 1);
  }

  /** Removes the mark at `path` only, and returns whether there was one. */
  unmark(path: string): boolean {
    if (!this.#marks.has(path)) return false;
    this.#writable().delete(path);
    this.#count(path, -1);
    return true;
  }

  /** Removes the marks at or below `path` and returns them. */
  unmarkAtOrBelow(path: string): string[] {
    const unmarked = this.#changedBelow.hasMarksBelow(path)
      ? [...this.#marks].filter((marked) => isSameOrDescendant(marked, path))
      : this.#marks.has(path)
        ? [path]
        : [];
    for (const marked of unmarked) this.unmark(marked);
    return unmarked;
  }

  /** Takes back every count change so far, for a batch whose marks are dropped instead of committed. */
  discard(): void {
    for (const { path, by } of this.#counted.reverse()) this.#changedBelow.count(path, by === 1 ? -1 : 1);
    this.#counted.length = 0;
  }

  #count(path: string, by: 1 | -1): void {
    this.#changedBelow.count(path, by);
    this.#counted.push({ path, by });
  }

  #writable(): Set<string> {
    if (!this.#copied) {
      this.#marks = new Set(this.#marks);
      this.#copied = true;
    }
    return this.#marks as Set<string>;
  }
}
