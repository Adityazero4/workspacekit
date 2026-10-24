'use client';
import type { VisibleRowIndex } from '@workspacekit/core';
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

interface RovingFocusState {
  readonly mountedRows: Map<string, HTMLElement>;
  readonly setFocusedPath: (path: string) => void;
  readonly setTreeHasFocus: (hasFocus: boolean) => void;
  pathToFocusOnMount: string | null;
  focusOnceVisible: { path: string; fromOutsideTheTree: boolean } | null;
  pathToScrollToAfterRender: string | null;
  scrollToIndex: ((rowIndex: number) => void) | null;
  committedIndexOrNullOnceUnmounted: VisibleRowIndex | null;
  lastCommittedIndex: VisibleRowIndex | null;
}

function focusPathIn(state: RovingFocusState, index: VisibleRowIndex, path: string): void {
  state.pathToFocusOnMount = null;
  state.focusOnceVisible = null;
  const rowIndex = index.indexOf(path);
  if (rowIndex < 0) return;
  state.setFocusedPath(path);
  state.scrollToIndex?.(rowIndex);
  const element = state.mountedRows.get(path);
  if (element) element.focus();
  else state.pathToFocusOnMount = path;
}

function keepFocusAfterRemoval(state: RovingFocusState, removedRowIndex: number): void {
  const index = state.committedIndexOrNullOnceUnmounted;
  const mountTarget = state.pathToFocusOnMount;
  if (mountTarget !== null && index && index.indexOf(mountTarget) >= 0) return;
  state.pathToFocusOnMount = null;
  if (!index || index.count === 0 || !focusFellToBody()) {
    state.setTreeHasFocus(false);
    return;
  }
  focusPathIn(state, index, index.rowAt(Math.min(Math.max(removedRowIndex, 0), index.count - 1)).path);
}

function fallBackWhenTheMountTargetLeft(
  state: RovingFocusState,
  index: VisibleRowIndex,
  previous: VisibleRowIndex | null,
): void {
  const mountTarget = state.pathToFocusOnMount;
  if (mountTarget === null || index.indexOf(mountTarget) >= 0) return;
  state.pathToFocusOnMount = null;
  if (focusFellToBody()) keepFocusAfterRemoval(state, previous?.indexOf(mountTarget) ?? -1);
}

function deliverOrDropTheFocusWaitingToBeVisible(state: RovingFocusState, index: VisibleRowIndex): void {
  const request = state.focusOnceVisible;
  state.focusOnceVisible = null;
  if (request === null || index.indexOf(request.path) < 0) return;
  const mayTakeFocus =
    request.fromOutsideTheTree || focusIsInsideOrNowhere(treeAroundRows(state.mountedRows));
  if (mayTakeFocus) focusPathIn(state, index, request.path);
}

function setCommittedIndex(state: RovingFocusState, index: VisibleRowIndex | null): void {
  state.committedIndexOrNullOnceUnmounted = index;
  if (!index) return;
  const previous = state.lastCommittedIndex;
  state.lastCommittedIndex = index;
  fallBackWhenTheMountTargetLeft(state, index, previous);
  deliverOrDropTheFocusWaitingToBeVisible(state, index);
}

function createRowBindings(state: RovingFocusState, rowIdPrefix: string): TreeRowBindings {
  const { mountedRows } = state;
  return {
    rowId: (rowIndex) => `${rowIdPrefix}-row-${rowIndex}`,
    registerRow: (path, element) => {
      mountedRows.set(path, element);
      if (state.pathToFocusOnMount === path) element.focus();
      return () => {
        if (mountedRows.get(path) === element) mountedRows.delete(path);
        const removedRowIndex = state.committedIndexOrNullOnceUnmounted?.indexOf(path) ?? -1;
        whenRemovedWhileFocused(element, mountedRows, () => keepFocusAfterRemoval(state, removedRowIndex));
      };
    },
    rowFocused: (path) => {
      state.pathToFocusOnMount = null;
      state.focusOnceVisible = null;
      state.setFocusedPath(path);
    },
  };
}

function createController(state: RovingFocusState, rowIdPrefix: string): RovingFocusController {
  return {
    bindings: createRowBindings(state, rowIdPrefix),
    focusPathIn: (index, path) => focusPathIn(state, index, path),
    focusPathOnceVisible: (path, opts) => {
      const index = state.committedIndexOrNullOnceUnmounted;
      if (index && index.indexOf(path) >= 0) {
        focusPathIn(state, index, path);
        return;
      }
      state.pathToFocusOnMount = null;
      state.focusOnceVisible = { path, fromOutsideTheTree: opts?.fromOutsideTheTree === true };
    },
    settleFocusWaitingToBeVisible: () => {
      const index = state.committedIndexOrNullOnceUnmounted;
      if (index) deliverOrDropTheFocusWaitingToBeVisible(state, index);
    },
    treeElement: () => treeAroundRows(state.mountedRows),
    scrollPathIntoViewAfterRender: (path) => {
      state.pathToScrollToAfterRender = path;
    },
    cancelFocusRequest: (path) => {
      if (state.pathToFocusOnMount === path) state.pathToFocusOnMount = null;
      if (state.focusOnceVisible?.path === path) state.focusOnceVisible = null;
    },
    rowIndexOfElement: (index, target) => {
      for (const [path, element] of state.mountedRows) if (element === target) return index.indexOf(path);
      return -1;
    },
    setScrollToIndex: (scroll) => {
      state.scrollToIndex = scroll;
      const path = state.pathToScrollToAfterRender;
      state.pathToScrollToAfterRender = null;
      const rowIndex = path === null ? -1 : (state.committedIndexOrNullOnceUnmounted?.indexOf(path) ?? -1);
      if (rowIndex >= 0) scroll(rowIndex);
    },
  };
}

function createRovingFocusController(
  rowIdPrefix: string,
  setFocusedPath: (path: string) => void,
  setTreeHasFocus: (hasFocus: boolean) => void,
): { controller: RovingFocusController; setCommittedIndex: (index: VisibleRowIndex | null) => void } {
  const state: RovingFocusState = {
    mountedRows: new Map(),
    setFocusedPath,
    setTreeHasFocus,
    pathToFocusOnMount: null,
    focusOnceVisible: null,
    pathToScrollToAfterRender: null,
    scrollToIndex: null,
    committedIndexOrNullOnceUnmounted: null,
    lastCommittedIndex: null,
  };
  return {
    controller: createController(state, rowIdPrefix),
    setCommittedIndex: (index) => setCommittedIndex(state, index),
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
