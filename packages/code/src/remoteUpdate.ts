import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * The smallest single replacement that turns `current` into `next`: everything between their common prefix
 * and their common suffix (which never overlap). Positions are UTF-16 offsets into `current`.
 *
 * @example
 * ```ts
 * minimalChange('abc', 'abXc'); // { from: 2, to: 2, insert: 'X' }
 * ```
 */
export function minimalChange(current: string, next: string): { from: number; to: number; insert: string } {
  const shorterLength = Math.min(current.length, next.length);
  let prefix = 0;
  while (prefix < shorterLength && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > prefix &&
    nextEnd > prefix &&
    current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    currentEnd--;
    nextEnd--;
  }
  return { from: prefix, to: currentEnd, insert: next.slice(prefix, nextEnd) };
}

/**
 * Shows a new version of the source (`next`, with `\n` line breaks) that arrived from outside the editor,
 * such as an agent's write. It is applied only while the editor still shows the previous source
 * (`previous`); otherwise the user has typed since, and their edits win until they are reported. The change
 * is the minimal diff, tagged `Transaction.remote` and kept out of the undo history, so the selection is
 * mapped through it, the scroll position stays, and undo never reverts someone else's write.
 *
 * @example
 * ```ts
 * applyRemoteUpdate(view, { previous: 'const a = 1;', next: 'const a = 2;' });
 * ```
 */
export function applyRemoteUpdate(view: EditorView, source: { previous: string; next: string }): void {
  const shown = view.state.doc.toString();
  if (shown !== source.previous || shown === source.next) return;
  view.dispatch({
    changes: minimalChange(shown, source.next),
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  });
}
