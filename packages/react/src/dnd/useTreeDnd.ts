'use client';
import {
  captureDataTransfer,
  entryAt,
  isSameOrDescendant,
  parentPath,
  validateTransfer,
  type DroppedItem,
  type Entry,
} from '@scope/core';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type DragEvent } from 'react';
import { transferInto } from '../actions/clipboard';
import { notifyActionFailed } from '../actions/useTreeActions';
import { useFileSystem, type FileSystemContext } from '../provider/hooks';
import { createUiStore, type UiStore } from '../provider/ui-store';
import type { FileTreeApi } from '../tree/useFileTree';

const FS_PATH_MIME = 'application/x-fs-path';
const HOVER_EXPAND_DELAY_MS = 400;

/**
 * The drag and drop handlers a tree shares with its rows and sticky headers. Identity-stable for the life of
 * the tree, so memoized rows never re-render for them; each row subscribes to `dropTarget` for its own state.
 *
 * @example
 * ```tsx
 * <div draggable onDragStart={(event) => drag.dragStart(event, entry)}
 *   onDragOver={(event) => drag.dragOver(event, entry)} />
 * ```
 */
export interface TreeDragHandlers {
  /** The folder a drop would land in, or `null` while nothing valid is under the pointer. */
  dropTarget: UiStore<string | null>;
  dragStart: (event: DragEvent, entry: Entry) => void;
  /** Over a row (`entry`) or over empty tree space (`null`, the root). */
  dragOver: (event: DragEvent, entry: Entry | null) => void;
  drop: (event: DragEvent, entry: Entry | null) => void;
}

/**
 * Props for the tree's scroll viewport: drops on empty space go to the root, and leaving the tree, cancelling
 * the drag (Esc) or ending it clears the target and the hover timer. A dragleave ends the drag unless a
 * dragenter on another element inside the tree came first, which the spec's dragenter-before-dragleave order
 * guarantees for moves within it.
 *
 * @example
 * ```tsx
 * <div {...dnd.viewportProps}>{rows}</div>
 * ```
 */
export interface TreeViewportDragProps {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/**
 * What `useTreeDnd` needs from the tree.
 *
 * @example
 * ```ts
 * const startUpload = (items: DroppedItem[], targetDir: string) => void uploads.upload(items, targetDir);
 * const dnd = useTreeDnd({ fs, tree, startUpload });
 * ```
 */
export interface TreeDndOptions {
  fs: FileSystemContext;
  tree: FileTreeApi;
  /** Uploads files dropped from the operating system into `targetDir`. */
  startUpload: (items: DroppedItem[], targetDir: string) => void;
}

type DropPlan =
  | { kind: 'transfer'; folder: string; op: 'move' | 'copy'; path: string }
  | { kind: 'upload'; folder: string };

interface TreeDragAndDrop {
  handlers: TreeDragHandlers;
  viewportProps: TreeViewportDragProps;
  update: (options: TreeDndOptions) => void;
  endDrag: () => void;
}

const folderUnder = (entry: Entry | null, root: string): string => {
  if (entry === null) return root;
  return entry.kind === 'directory' ? entry.path : parentPath(entry.path);
};

const adapterCan = (fs: FileSystemContext, op: 'move' | 'copy'): boolean =>
  op === 'move' ? fs.adapter.move !== undefined : fs.adapter.copy !== undefined;

async function transferDropped(
  fs: FileSystemContext,
  plan: Extract<DropPlan, { kind: 'transfer' }>,
): Promise<void> {
  const entry = entryAt(fs.store.getSnapshot().tree, plan.path);
  if (!entry) return;
  try {
    await transferInto(fs, { op: plan.op, path: plan.path, folder: plan.folder, verb: plan.op });
  } catch (error) {
    notifyActionFailed(fs, plan.op === 'move' ? 'Move' : 'Copy', entry, error);
  }
}

function createTreeDragAndDrop(): TreeDragAndDrop {
  let options: TreeDndOptions | null = null;
  let draggedPath: string | null = null;
  let stopWatchingTheDragEnd: (() => void) | null = null;
  let hoverExpand: { path: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let lastEnteredElement: EventTarget | null = null;
  const dropTarget = createUiStore<string | null>(null);

  const forgetDraggedRow = (): void => {
    draggedPath = null;
    stopWatchingTheDragEnd?.();
    stopWatchingTheDragEnd = null;
  };
  const rememberDraggedRow = (path: string, source: EventTarget): void => {
    forgetDraggedRow();
    draggedPath = path;
    source.addEventListener('dragend', finishDrag);
    document.addEventListener('drop', finishDrag);
    stopWatchingTheDragEnd = () => {
      source.removeEventListener('dragend', finishDrag);
      document.removeEventListener('drop', finishDrag);
    };
  };

  const cancelHoverExpand = (): void => {
    if (hoverExpand) clearTimeout(hoverExpand.timer);
    hoverExpand = null;
  };
  const expandAfterHovering = (folder: Entry): void => {
    if (hoverExpand?.path === folder.path) return;
    cancelHoverExpand();
    if (!options || options.fs.expanded.get().has(folder.path)) return;
    const { tree } = options;
    hoverExpand = {
      path: folder.path,
      timer: setTimeout(() => {
        hoverExpand = null;
        tree.expand(folder.path);
      }, HOVER_EXPAND_DELAY_MS),
    };
  };
  const endDrag = (): void => {
    cancelHoverExpand();
    lastEnteredElement = null;
    dropTarget.set(null);
  };
  const finishDrag = (): void => {
    forgetDraggedRow();
    endDrag();
  };

  const planFor = (event: DragEvent, entry: Entry | null): DropPlan | null => {
    if (!options) return null;
    const { fs } = options;
    const types = Array.from(event.dataTransfer.types);
    const folder = folderUnder(entry, fs.root);
    if (types.includes(FS_PATH_MIME) && draggedPath !== null) {
      const op = event.altKey ? 'copy' : 'move';
      const valid = adapterCan(fs, op) && validateTransfer(op, draggedPath, folder) === null;
      return valid ? { kind: 'transfer', folder, op, path: draggedPath } : null;
    }
    if (types.includes('Files') && fs.adapter.upload) return { kind: 'upload', folder };
    return null;
  };

  const dragOver = (event: DragEvent, entry: Entry | null): void => {
    event.stopPropagation();
    const plan = planFor(event, entry);
    if (plan && entry?.kind === 'directory') expandAfterHovering(entry);
    else cancelHoverExpand();
    dropTarget.set(plan?.folder ?? null);
    if (!plan) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = plan.kind === 'upload' ? 'copy' : plan.op;
  };

  const carriesTheDraggedRow = (event: DragEvent, fs: FileSystemContext, path: string): boolean =>
    event.dataTransfer.getData(FS_PATH_MIME) === path &&
    entryAt(fs.store.getSnapshot().tree, path) !== undefined;

  const drop = (event: DragEvent, entry: Entry | null): void => {
    event.stopPropagation();
    const plan = planFor(event, entry);
    finishDrag();
    if (!plan || !options) return;
    event.preventDefault();
    if (plan.kind === 'transfer' && !carriesTheDraggedRow(event, options.fs, plan.path)) return;
    if (plan.kind === 'transfer') void transferDropped(options.fs, plan);
    else options.startUpload(captureDataTransfer(event.dataTransfer), plan.folder);
  };

  return {
    handlers: {
      dropTarget,
      dragStart: (event, entry) => {
        rememberDraggedRow(entry.path, event.currentTarget);
        event.dataTransfer.setData(FS_PATH_MIME, entry.path);
        event.dataTransfer.setData('text/plain', entry.path);
        event.dataTransfer.effectAllowed = 'copyMove';
      },
      dragOver,
      drop,
    },
    viewportProps: {
      onDragEnter: (event) => {
        lastEnteredElement = event.target;
        if (!Array.from(event.dataTransfer.types).includes(FS_PATH_MIME)) forgetDraggedRow();
      },
      onDragOver: (event) => dragOver(event, null),
      onDrop: (event) => drop(event, null),
      onDragLeave: (event) => {
        const enteredAnotherElementInside =
          lastEnteredElement !== null && lastEnteredElement !== event.target;
        if (!enteredAnotherElementInside) endDrag();
      },
      onDragEnd: finishDrag,
    },
    update: (latest) => {
      options = latest;
    },
    endDrag: finishDrag,
  };
}

/**
 * The tree's native HTML5 drag and drop. Dragging a row carries its path (`application/x-fs-path`); a plain
 * drop moves it and an Alt (Option) drop copies it, through the same validation as paste. Files dragged in
 * from the operating system upload into the folder under the pointer, when the adapter can upload. Over a
 * file row the target is its folder; a folder hovered for 400 ms opens. Invalid targets (into itself, or a
 * move into the folder the entry is already in) show no target and refuse the drop. The hover timer is
 * cleared on leave, cancel, drop and unmount.
 *
 * A drop moves an entry only when it carries the path this tree's own drag started with and that entry still
 * exists, so a drag from another page or app that sets `application/x-fs-path` moves nothing (its drop is
 * still cancelled, so the browser does not open the dragged data). The dragged row is forgotten when its drag
 * ends, even if the row unmounted first, or when a drag without that type enters the tree. Dragging between
 * two trees is not supported.
 *
 * @example
 * ```tsx
 * const dnd = useTreeDnd({ fs, tree, startUpload });
 * <div {...dnd.viewportProps}>
 *   <TreeRowContext value={{ ...shared, drag: dnd.handlers }}>{rows}</TreeRowContext>
 * </div>
 * ```
 */
export function useTreeDnd(options: TreeDndOptions): {
  handlers: TreeDragHandlers;
  viewportProps: TreeViewportDragProps;
} {
  const [dragAndDrop] = useState(createTreeDragAndDrop);
  useLayoutEffect(() => dragAndDrop.update(options));
  useEffect(() => dragAndDrop.endDrag, [dragAndDrop]);
  return { handlers: dragAndDrop.handlers, viewportProps: dragAndDrop.viewportProps };
}

/**
 * Whether `path` is inside the current drop target (the target folder or one of its visible rows); re-renders
 * only when that changes. The root as a target marks the viewport instead, so no row re-renders for it.
 *
 * @example
 * ```tsx
 * const isDropTarget = useIsInDropTarget(shared.drag.dropTarget, path);
 * ```
 */
export function useIsInDropTarget(dropTarget: UiStore<string | null>, path: string): boolean {
  const { root } = useFileSystem();
  const read = (): boolean => {
    const target = dropTarget.get();
    return target !== null && target !== root && isSameOrDescendant(path, target);
  };
  return useSyncExternalStore(dropTarget.subscribe, read, read);
}

/**
 * Whether the root folder is the current drop target.
 *
 * @example
 * ```tsx
 * <div data-drop-target={useIsRootDropTarget(dnd.handlers.dropTarget) ? '' : undefined} />
 * ```
 */
export function useIsRootDropTarget(dropTarget: UiStore<string | null>): boolean {
  const { root } = useFileSystem();
  const read = (): boolean => dropTarget.get() === root;
  return useSyncExternalStore(dropTarget.subscribe, read, read);
}
