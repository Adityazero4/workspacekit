'use client';
import { toFsError, type Entry, type EntryKind, type VisibleRow } from '@workspacekit/core';
import { useLayoutEffect, useState, type KeyboardEvent } from 'react';
import type { MenuAnchor } from '../components';
import { failureMessage, useFileSystem, type FileSystemContext } from '../provider/hooks';
import { createUiStore, type UiStore } from '../provider/ui-store';
import { isMac, treeKeyIntent, type TreeKeyIntent } from '../tree/keyboard';
import type { FileTreeApi } from '../tree/useFileTree';
import type { UploadPickerKind } from '../uploads/useUploadInputs';
import { actionsFor, type Action, type ActionContext, type CanPerform, type ConfirmRequest } from './actions';
import { builtinActions } from './builtin';
import { matchesShortcut } from './shortcuts';

/**
 * The menu or dialog a tree shows; at most one at a time. `returnTo` is the row that gets focus back when it
 * closes, unless `returnFocusTo` names the element outside the tree it was opened from (a toolbar button).
 *
 * @example
 * ```ts
 * overlay.set({ kind: 'menu', path: 'a.txt', anchor: { x: 10, y: 20 } });
 * ```
 */
export type TreeOverlay =
  | { kind: 'menu'; path: string; anchor: MenuAnchor }
  | { kind: 'create'; entryKind: EntryKind; parent: string; returnTo: string; returnFocusTo?: HTMLElement }
  | {
      kind: 'confirm';
      request: ConfirmRequest;
      returnTo: string;
      returnFocusTo?: HTMLElement;
      answer: (confirmed: boolean) => void;
    };

/**
 * What `useTreeActions` returns to `FileTree`.
 *
 * @example
 * ```tsx
 * <div
 *   {...tree.getTreeProps()}
 *   onKeyDown={(event) => {
 *     treeProps.onKeyDown(event);
 *     treeActions.onKeyDown(event);
 *   }}
 * />
 * ```
 */
export interface TreeActions {
  overlay: UiStore<TreeOverlay | null>;
  /**
   * Opens `entry`'s menu at `anchor`, unless no action applies to it; returns whether it opened, so a caller
   * suppresses the browser's own context menu only then. Identity-stable, so memoized rows never re-render
   * for it.
   */
  openMenu: (entry: Entry, anchor: MenuAnchor) => boolean;
  /** The actions shown for `entry` on every surface: menu, More actions and shortcuts. */
  visibleFor: (entry: Entry) => Action[];
  /** Runs an action; a failure becomes an error notice. */
  run: (action: Action, entry: Entry) => void;
  /**
   * `TreeCommands.runAction`: runs a shown action from outside the tree, returning focus to `returnFocusTo`.
   */
  runFromOutside: (actionId: string, entry: Entry, returnFocusTo: HTMLElement) => void;
  /**
   * Runs shortcuts and opens the menu (Shift+F10, ContextMenu) for keys the tree itself left alone.
   * Auto-repeated key presses are ignored, so holding Mod+V pastes once.
   */
  onKeyDown: (event: KeyboardEvent) => void;
}

const MORE_ACTIONS_BUTTON = '[data-fs-part=tree-row-more]';

/**
 * Where a menu opened from `element` (a row or its More actions button) appears: below its start edge.
 *
 * @example
 * ```ts
 * openMenu(path, anchorBelow(event.currentTarget));
 * ```
 */
export function anchorBelow(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

function builtinIdFor(intent: TreeKeyIntent): string | undefined {
  if (intent.kind === 'clipboard') return intent.op;
  if (intent.kind === 'delete' || intent.kind === 'rename') return intent.kind;
  return undefined;
}

function createLatestVisibleActions(): {
  read: (entry: Entry) => Action[];
  update: (visibleFor: (entry: Entry) => Action[]) => void;
} {
  let latest: (entry: Entry) => Action[] = () => [];
  return {
    read: (entry) => latest(entry),
    update: (visibleFor) => {
      latest = visibleFor;
    },
  };
}

const withoutEllipsis = (label: string): string => label.replace(/…$/, '');

/**
 * Reports a failed action on `entry` as an error notice: `<label> failed for "<name>": <reason>. Try again.`
 *
 * @example
 * ```ts
 * notifyActionFailed(fs, 'Rename', entry, error);
 * ```
 */
export function notifyActionFailed(fs: FileSystemContext, label: string, entry: Entry, error: unknown): void {
  const fsError = toFsError(error);
  fs.notify({
    kind: 'error',
    message: failureMessage(`${withoutEllipsis(label)} failed for "${entry.name}"`, fsError),
    error: fsError,
  });
}

async function runReportingFailures(
  action: Action,
  entry: Entry,
  context: ActionContext,
  fs: FileSystemContext,
): Promise<void> {
  try {
    await action.run(entry, context);
  } catch (error) {
    notifyActionFailed(fs, action.label, entry, error);
  }
}

function focusedRowReceiving(tree: FileTreeApi, event: KeyboardEvent): VisibleRow | undefined {
  const isOnARow = (event.target as Element).getAttribute('role') === 'treeitem';
  if (event.defaultPrevented || event.repeat || !isOnARow || tree.focusedPath === null) return undefined;
  const rowIndex = tree.index.indexOf(tree.focusedPath);
  return rowIndex < 0 ? undefined : tree.index.rowAt(rowIndex);
}

function actionForKey(
  shown: Action[],
  intent: TreeKeyIntent,
  event: KeyboardEvent,
  isMacPlatform: boolean,
): Action | undefined {
  const builtinId = builtinIdFor(intent);
  return (
    shown.find((candidate) => candidate.id === builtinId) ??
    shown.find(
      (candidate) =>
        candidate.shortcut !== undefined && matchesShortcut(candidate.shortcut, event, isMacPlatform),
    )
  );
}

function useIdentityStableOpenMenu(
  overlay: UiStore<TreeOverlay | null>,
  visibleFor: (entry: Entry) => Action[],
): TreeActions['openMenu'] {
  const [latestVisibleActions] = useState(createLatestVisibleActions);
  const { read: visibleForLatest, update: updateVisibleFor } = latestVisibleActions;
  useLayoutEffect(() => updateVisibleFor(visibleFor));
  return (entry, anchor) => {
    if (visibleForLatest(entry).length === 0) return false;
    const { path } = entry;
    overlay.set((current) =>
      current?.kind === 'menu' && current.path === path ? current : { kind: 'menu', path, anchor },
    );
    return true;
  };
}

/**
 * The tree's actions: the built-in ones the adapter supports plus `actions`, filtered by `when` and
 * `canPerform`, and the menu and dialog state they open.
 *
 * @example
 * ```tsx
 * const treeActions = useTreeActions(tree, { actions, canPerform, pickUploads });
 * ```
 */
export function useTreeActions(
  tree: FileTreeApi,
  options: {
    actions?: Action[];
    canPerform?: CanPerform;
    pickUploads: (kind: UploadPickerKind, targetDir: string) => void;
  },
): TreeActions {
  const fs = useFileSystem();
  const [overlay] = useState(() => createUiStore<TreeOverlay | null>(null));
  const all = [...builtinActions(fs.adapter), ...(options.actions ?? [])];
  const contextFor = (entry: Entry, returnFocusTo?: HTMLElement): ActionContext => ({
    entry,
    fs,
    tree,
    startRename: tree.startRename,
    openCreate: (entryKind, parent) =>
      overlay.set({ kind: 'create', entryKind, parent, returnTo: entry.path, returnFocusTo }),
    confirm: (request) =>
      new Promise((answer) =>
        overlay.set({ kind: 'confirm', request, returnTo: entry.path, returnFocusTo, answer }),
      ),
    pickUploads: options.pickUploads,
  });
  const visibleFor = (entry: Entry): Action[] =>
    actionsFor(all, entry, contextFor(entry), options.canPerform);
  const run = (action: Action, entry: Entry): void =>
    void runReportingFailures(action, entry, contextFor(entry), fs);
  const runFromOutside = (actionId: string, entry: Entry, returnFocusTo: HTMLElement): void => {
    const action = visibleFor(entry).find((candidate) => candidate.id === actionId);
    if (action) void runReportingFailures(action, entry, contextFor(entry, returnFocusTo), fs);
  };
  const openMenu = useIdentityStableOpenMenu(overlay, visibleFor);
  const onKeyDown = (event: KeyboardEvent): void => {
    const row = focusedRowReceiving(tree, event);
    if (!row) return;
    const target = event.target as Element;
    const isMacPlatform = isMac();
    const intent = treeKeyIntent(event, row, tree.index, isMacPlatform);
    if (intent.kind === 'menu') {
      if (openMenu(row.entry, anchorBelow(target.querySelector(MORE_ACTIONS_BUTTON) ?? target))) {
        event.preventDefault();
      }
      return;
    }
    const action = actionForKey(visibleFor(row.entry), intent, event, isMacPlatform);
    if (!action) return;
    event.preventDefault();
    run(action, row.entry);
  };

  return { overlay, openMenu, visibleFor, run, runFromOutside, onKeyDown };
}
