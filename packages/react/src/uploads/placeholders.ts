import type { VisibleRowIndex } from '@scope/core';
import type { PlaceholderGroup, PlaceholderRow } from '../tree/rowLayout';
import type { UploadRun } from './uploads';

const percentOf = ({ progress }: UploadRun): number =>
  Math.round(
    100 *
      (progress.totalBytes > 0
        ? progress.loadedBytes / progress.totalBytes
        : progress.done / Math.max(1, progress.total)),
  );

/**
 * The placeholder groups for the running uploads: one row per top-level item, right under its target folder
 * while that folder is open (at the top for the root); a run into a closed or hidden folder shows none.
 *
 * @example
 * ```ts
 * const layout = createRowLayout(tree.index.count, uploadPlaceholderGroups(runs, tree.index, fs.root));
 * ```
 */
export function uploadPlaceholderGroups(
  runs: readonly UploadRun[],
  index: VisibleRowIndex,
  root: string,
): PlaceholderGroup[] {
  const groups = new Map<number, PlaceholderRow[]>();
  for (const run of runs) {
    if (run.status !== 'running') continue;
    const targetIndex = run.targetDir === root ? -1 : index.indexOf(run.targetDir);
    const target = targetIndex < 0 ? undefined : index.rowAt(targetIndex);
    if (run.targetDir !== root && !target?.isExpanded) continue;
    const depth = target ? target.depth + 1 : 0;
    const percent = percentOf(run);
    const group = groups.get(targetIndex) ?? [];
    for (const name of run.topLevelNames) {
      group.push({ key: `/${run.id}/${name}`, name, depth, percent, target: target?.entry ?? null });
    }
    groups.set(targetIndex, group);
  }
  return [...groups].map(([afterRowIndex, rows]) => ({ afterRowIndex, rows }));
}
