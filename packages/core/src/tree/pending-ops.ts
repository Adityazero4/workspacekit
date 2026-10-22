import { parentPath } from '../path';
import { applyBatch, type TreeData, type TreeOp } from './model';

/**
 * The tree operations of one `applyChanges` batch, queued so the batch is applied once. A change that must
 * read the tree under a path an earlier change touched flushes the queue first.
 *
 * @example
 * ```ts
 * const pending = new PendingTreeOps(tree);
 * pending.queue({ kind: 'remove', path: 'docs/a.txt' });
 * pending.markTouchedByPendingOps('docs/a.txt');
 * const next = pending.finish();
 * ```
 */
export class PendingTreeOps {
  #tree: TreeData;
  readonly #ops: TreeOp[] = [];
  readonly #touched = new Set<string>();

  constructor(tree: TreeData) {
    this.#tree = tree;
  }

  /** The tree as of the last flush; queued operations are not applied to it. */
  get treeWithoutPendingOps(): TreeData {
    return this.#tree;
  }

  /** Queues operations for the next flush or `finish`. */
  queue(...ops: TreeOp[]): void {
    this.#ops.push(...ops);
  }

  /** Records that the queued operations change the tree at `paths`. */
  markTouchedByPendingOps(...paths: string[]): void {
    for (const path of paths) this.#touched.add(path);
  }

  /** The tree to read `path` from: flushes the queue first when it touches `path` or one of its ancestors. */
  treeAfterFlushingOpsTouching(path: string): TreeData {
    for (let ancestorOrSelf = path; ; ancestorOrSelf = parentPath(ancestorOrSelf)) {
      if (this.#touched.has(ancestorOrSelf)) {
        this.#tree = applyBatch(this.#tree, this.#ops.splice(0));
        this.#touched.clear();
        break;
      }
      if (ancestorOrSelf === '') break;
    }
    return this.#tree;
  }

  /** The tree with every queued operation applied. */
  finish(): TreeData {
    return applyBatch(this.#tree, this.#ops);
  }
}
