import type { VisibleRow, VisibleRowIndex } from '@workspacekit/core';

/**
 * What a key press on a tree row asks for. `move` targets a row index in the same `VisibleRowIndex`.
 *
 * @example
 * ```ts
 * if (intent.kind === 'expand') expand(intent.path);
 * ```
 */
export type TreeKeyIntent =
  | { kind: 'move'; index: number }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'expandSiblings'; parent: string }
  | { kind: 'open'; path: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'menu'; path: string }
  | { kind: 'clipboard'; op: 'cut' | 'copy' | 'paste'; path: string }
  | { kind: 'typeahead'; char: string }
  | { kind: 'none' };

const CLIPBOARD: Record<string, 'cut' | 'copy' | 'paste'> = { x: 'cut', c: 'copy', v: 'paste' };
const NONE: TreeKeyIntent = { kind: 'none' };
const isPrintable = (key: string): boolean => [...key].length === 1;

/**
 * Whether the browser runs on an Apple platform, where Cmd (not Ctrl) is the shortcut modifier.
 *
 * @example
 * ```ts
 * const modifierLabel = isMac() ? '⌘' : 'Ctrl';
 * ```
 */
export function isMac(): boolean {
  const navigatorWithUserAgentData = navigator as Navigator & { userAgentData?: { platform: string } };
  const platform = navigatorWithUserAgentData.userAgentData?.platform || navigatorWithUserAgentData.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Maps a key press on `row` to an intent, following the WAI-ARIA tree pattern. Pure: the caller applies the
 * intent.
 *
 * @param isMacPlatform Makes Cmd the clipboard modifier (Ctrl elsewhere) and Backspace a delete key. A
 * parameter, not a lookup, so the mapping stays deterministic; the hook passes `isMac()`.
 * @returns `{ kind: 'none' }` when the key means nothing on this row.
 *
 * @example
 * ```ts
 * const intent = treeKeyIntent(event, index.rowAt(rowIndex), index, isMac());
 * if (intent.kind === 'move') focus(index.rowAt(intent.index).path);
 * ```
 */
export function treeKeyIntent(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  row: VisibleRow,
  index: VisibleRowIndex,
  isMacPlatform = false,
): TreeKeyIntent {
  const key = event.key;
  const path = row.path;
  if (event.altKey || event.ctrlKey || event.metaKey) {
    const modifierHeld = isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const op = CLIPBOARD[key.toLowerCase()];
    return modifierHeld && op && !event.altKey && !event.shiftKey ? { kind: 'clipboard', op, path } : NONE;
  }
  const current = index.indexOf(path);
  const isDirectory = row.entry.kind === 'directory';
  const moveTo = (target: number): TreeKeyIntent =>
    target >= 0 && target < index.count && target !== current ? { kind: 'move', index: target } : NONE;
  switch (key) {
    case 'ArrowDown':
      return moveTo(current + 1);
    case 'ArrowUp':
      return moveTo(current - 1);
    case 'ArrowRight':
      if (isDirectory && !row.isExpanded) return { kind: 'expand', path };
      return isDirectory && current + 1 < index.count && index.rowAt(current + 1).parentPath === path
        ? moveTo(current + 1)
        : NONE;
    case 'ArrowLeft':
      return isDirectory && row.isExpanded
        ? { kind: 'collapse', path }
        : moveTo(index.indexOf(row.parentPath));
    case 'Home':
      return moveTo(0);
    case 'End':
      return moveTo(index.count - 1);
    case '*':
      return { kind: 'expandSiblings', parent: row.parentPath };
    case 'Enter':
      return { kind: 'open', path };
    case 'F2':
      return { kind: 'rename', path };
    case 'Delete':
      return { kind: 'delete', path };
    case 'Backspace':
      return isMacPlatform ? { kind: 'delete', path } : NONE;
    case 'ContextMenu':
      return { kind: 'menu', path };
    case 'F10':
      return event.shiftKey ? { kind: 'menu', path } : NONE;
  }
  return isPrintable(key) ? { kind: 'typeahead', char: key } : NONE;
}
