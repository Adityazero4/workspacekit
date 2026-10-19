'use client';
import type { VisibleRowIndex } from '@scope/core';
import { useId, useLayoutEffect, useState, type FocusEventHandler } from 'react';

/**
 * Row handlers whose identity never changes for the life of the tree, so a memoized row can register itself
 * and report focus without receiving new props.
 *
 * @example
 * ```tsx
 * <div id={bindings.rowId(rowIndex)} ref={(element) => bindings.registerRow(path, element)} />
 * ```
 */
export interface TreeRowBindings {
  /** A row id unique to this tree. Ids follow the row index, so never keep one across renders. */
  rowId: (rowIndex: number) => string;
  /** Call from the row's ref: lets `focus(path)` reach the element, and returns the ref cleanup. */
  registerRow: (path: string, element: HTMLElement) => () => void;
  /** Call from the row's `onFocus` when the row element itself receives focus. */
  rowFocused: (path: string) => void;
}

/**
 * The tree's roving focus: which row holds focus, whether DOM focus is inside the tree, and the
 * identity-stable controller that tracks mounted rows, pending focus requests and focus safety.
 *
 * @example
 * ```ts
 * const { focusedPath, controller } = useRovingFocus(index);
 * controller.focusPathIn(index, 'src/index.ts');
 * ```
 */
export interface RovingFocus {
  focusedPath: string | null;
  treeHasFocus: boolean;
  controller: RovingFocusController;
  treeFocusHandlers: { onFocus: FocusEventHandler; onBlur: FocusEventHandler };
}

/**
 * What `useRovingFocus` keeps for the life of the tree.
 *
 * @example
 * ```ts
 * controller.setScrollToIndex((rowIndex) => virtualizer.scrollToIndex(rowIndex));
 * ```
 */
export interface RovingFocusController {
  bindings: TreeRowBindings;
  /**
   * Scrolls `path` into view, then focuses its row now or once it mounts; does nothing for a row not in
   * `index`.
   */
  focusPathIn: (index: VisibleRowIndex, path: string) => void;
  /**
   * Like `focusPathIn` over the committed index, but a path that is not visible yet (a renamed entry before
   * the tree re-renders) waits for the next committed index: it is focused if that index contains it and
   * focus is in the tree or nowhere, and dropped otherwise. With `fromOutsideTheTree`, for an explicit
   * request such as a reveal, it is focused wherever focus is. A later focus request replaces it.
   */
  focusPathOnceVisible: (path: string, opts?: { fromOutsideTheTree?: boolean }) => void;
  /**
   * Ends a `focusPathOnceVisible` request still waiting after a commit that did not change the index: focuses
   * its row if the committed index now contains it, and drops it otherwise, so it can never take focus later.
   */
  settleFocusWaitingToBeVisible: () => void;
  /**
   * Scrolls `path` into view without focusing it, once the renderer has rendered the tree with it and
   * registered that render's `scrollToIndex`; dropped when the row is not visible then (a path under a hidden
   * name).
   */
  scrollPathIntoViewAfterRender: (path: string) => void;
  /** Drops a focus request for `path` that is still waiting (for its row to be visible or to mount). */
  cancelFocusRequest: (path: string) => void;
  /** The element with `role="tree"` around the mounted rows, or `null` while no row is mounted. */
  treeElement: () => Element | null;
  rowIndexOfElement: (index: VisibleRowIndex, target: EventTarget) => number;
  /**
   * The renderer registers its `scrollToIndex` after every render; a waiting scroll-only request then runs.
   */
  setScrollToIndex: (scrollToIndex: (rowIndex: number) => void) => void;
}

/**
 * Roving focus for a tree over `index`. When a row is removed while it has DOM focus (deleted, moved,
 * collapsed away or hidden), focus moves to the row now at its index, or the last row; with no rows left the
 * tree forgets its focus. A focus request waiting for its row to mount wins over that, unless its row leaves
 * the index first.
 *
 * @example
 * ```ts
 * const rovingFocus = useRovingFocus(index);
 * ```
 */
export function useRovingFocus(index: VisibleRowIndex): RovingFocus {
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [treeHasFocus, setTreeHasFocus] = useState(false);
  const rowIdPrefix = useId();
  const [stableForTheLifeOfTheTree] = useState(() =>
    createRovingFocusController(rowIdPrefix, setFocusedPath, setTreeHasFocus),
  );
  const { controller, setCommittedIndex } = stableForTheLifeOfTheTree;
  useLayoutEffect(() => {
    setCommittedIndex(index);
    return () => setCommittedIndex(null);
  }, [setCommittedIndex, index]);

  return {
    focusedPath,
    treeHasFocus,
    controller,
    treeFocusHandlers: {
      onFocus: () => setTreeHasFocus(true),
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setTreeHasFocus(false);
      },
    },
  };
}

/**
 * Whether focus is nowhere: on the body, such as after the focused element was removed.
 *
 * @example
 * ```ts
 * if (focusFellToBody()) row.focus();
 * ```
 */
export function focusFellToBody(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Whether focus is nowhere (on the body) or inside `container`, so moving it would not take it from somewhere
 * else.
 *
 * @example
 * ```ts
 * if (focusIsInsideOrNowhere(input.closest('[role=tree]'))) input.focus();
 * ```
 */
export function focusIsInsideOrNowhere(container: Element | null | undefined): boolean {
  return focusFellToBody() || (container?.contains(document.activeElement) ?? false);
}

function treeAroundRows(mountedRows: ReadonlyMap<string, HTMLElement>): Element | null {
  const [anyRow] = mountedRows.values();
  return anyRow?.closest('[role=tree]') ?? null;
}

function createRovingFocusController(
  rowIdPrefix: string,
  setFocusedPath: (path: string) => void,
  setTreeHasFocus: (hasFocus: boolean) => void,
): { controller: RovingFocusController; setCommittedIndex: (index: VisibleRowIndex | null) => void } {
  const mountedRows = new Map<string, HTMLElement>();
  let pathToFocusOnMount: string | null = null;
  let focusOnceVisible: { path: string; fromOutsideTheTree: boolean } | null = null;
  let pathToScrollToAfterRender: string | null = null;
  let scrollToIndex: ((rowIndex: number) => void) | null = null;
  let committedIndexOrNullOnceUnmounted: VisibleRowIndex | null = null;
  let lastCommittedIndex: VisibleRowIndex | null = null;

  const focusPathIn = (index: VisibleRowIndex, path: string): void => {
    pathToFocusOnMount = null;
    focusOnceVisible = null;
    const rowIndex = index.indexOf(path);
    if (rowIndex < 0) return;
    setFocusedPath(path);
    scrollToIndex?.(rowIndex);
    const element = mountedRows.get(path);
    if (element) element.focus();
    else pathToFocusOnMount = path;
  };
  const keepFocusAfterRemoval = (removedRowIndex: number): void => {
    const index = committedIndexOrNullOnceUnmounted;
    const mountTarget = pathToFocusOnMount;
    if (mountTarget !== null && index && index.indexOf(mountTarget) >= 0) return;
    pathToFocusOnMount = null;
    if (!index || index.count === 0 || !focusFellToBody()) {
      setTreeHasFocus(false);
      return;
    }
    focusPathIn(index, index.rowAt(Math.min(Math.max(removedRowIndex, 0), index.count - 1)).path);
  };
  const fallBackWhenTheMountTargetLeft = (index: VisibleRowIndex, previous: VisibleRowIndex | null): void => {
    const mountTarget = pathToFocusOnMount;
    if (mountTarget === null || index.indexOf(mountTarget) >= 0) return;
    pathToFocusOnMount = null;
    if (focusFellToBody()) keepFocusAfterRemoval(previous?.indexOf(mountTarget) ?? -1);
  };
  const deliverOrDropTheFocusWaitingToBeVisible = (index: VisibleRowIndex): void => {
    const request = focusOnceVisible;
    focusOnceVisible = null;
    if (request === null || index.indexOf(request.path) < 0) return;
    const mayTakeFocus = request.fromOutsideTheTree || focusIsInsideOrNowhere(treeAroundRows(mountedRows));
    if (mayTakeFocus) focusPathIn(index, request.path);
  };

  const bindings: TreeRowBindings = {
    rowId: (rowIndex) => `${rowIdPrefix}-row-${rowIndex}`,
    registerRow: (path, element) => {
      mountedRows.set(path, element);
      if (pathToFocusOnMount === path) element.focus();
      return () => {
        if (mountedRows.get(path) === element) mountedRows.delete(path);
        const removedRowIndex = committedIndexOrNullOnceUnmounted?.indexOf(path) ?? -1;
        whenRemovedWhileFocused(element, mountedRows, () => keepFocusAfterRemoval(removedRowIndex));
      };
    },
    rowFocused: (path) => {
      pathToFocusOnMount = null;
      focusOnceVisible = null;
      setFocusedPath(path);
    },
  };
  return {
    controller: {
      bindings,
      focusPathIn,
      focusPathOnceVisible: (path, opts) => {
        const index = committedIndexOrNullOnceUnmounted;
        if (index && index.indexOf(path) >= 0) {
          focusPathIn(index, path);
          return;
        }
        pathToFocusOnMount = null;
        focusOnceVisible = { path, fromOutsideTheTree: opts?.fromOutsideTheTree === true };
      },
      settleFocusWaitingToBeVisible: () => {
        const index = committedIndexOrNullOnceUnmounted;
        if (index) deliverOrDropTheFocusWaitingToBeVisible(index);
      },
      treeElement: () => treeAroundRows(mountedRows),
      scrollPathIntoViewAfterRender: (path) => {
        pathToScrollToAfterRender = path;
      },
      cancelFocusRequest: (path) => {
        if (pathToFocusOnMount === path) pathToFocusOnMount = null;
        if (focusOnceVisible?.path === path) focusOnceVisible = null;
      },
      rowIndexOfElement: (index, target) => {
        for (const [path, element] of mountedRows) if (element === target) return index.indexOf(path);
        return -1;
      },
      setScrollToIndex: (scroll) => {
        scrollToIndex = scroll;
        const path = pathToScrollToAfterRender;
        pathToScrollToAfterRender = null;
        const rowIndex = path === null ? -1 : (committedIndexOrNullOnceUnmounted?.indexOf(path) ?? -1);
        if (rowIndex >= 0) scroll(rowIndex);
      },
    },
    setCommittedIndex: (index) => {
      committedIndexOrNullOnceUnmounted = index;
      if (!index) return;
      const previous = lastCommittedIndex;
      lastCommittedIndex = index;
      fallBackWhenTheMountTargetLeft(index, previous);
      deliverOrDropTheFocusWaitingToBeVisible(index);
    },
  };
}

function whenRemovedWhileFocused(
  element: HTMLElement,
  mountedRows: ReadonlyMap<string, HTMLElement>,
  onRemoved: () => void,
): void {
  if (!element.contains(document.activeElement)) return;
  queueMicrotask(() => {
    const active = document.activeElement;
    const focusIsInsideAMountedRow = [...mountedRows.values()].some((row) => row.contains(active));
    if (element.isConnected || focusIsInsideAMountedRow) return;
    onRemoved();
  });
}
