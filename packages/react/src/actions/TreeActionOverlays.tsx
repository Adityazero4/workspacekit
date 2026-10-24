'use client';
import { joinPath, toFsError, type Entry, type EntryKind } from '@workspacekit/core';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Components } from '../components';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { ConflictDialog } from '../dialogs/ConflictDialog';
import type { ConflictAnswer, ConflictQueue, ConflictRequest } from '../dialogs/conflicts';
import { CreateDialog } from '../dialogs/CreateDialog';
import { DefaultDialog } from '../dialogs/Dialog';
import type { ClassNames } from '../parts';
import { failureMessage, useFileSystem, useUiValue, type FileSystemContext } from '../provider/hooks';
import { internalsOf } from '../provider/internals';
import { focusIsInsideOrNowhere } from '../tree/rovingFocus';
import type { FileTreeApi } from '../tree/useFileTree';
import { ActionMenu, DefaultMenu } from './ActionMenu';
import type { Action } from './actions';
import type { TreeActions, TreeOverlay } from './useTreeActions';

interface FocusReturn {
  path: string;
  returnFocusTo?: HTMLElement;
  afterFocusReturns?: () => void;
  ifCancelled?: () => void;
  waitForRowToAppear?: boolean;
  focus?: 'returnToTheRow' | 'leaveWhereTheUserPutIt' | 'returnWithoutScrolling';
}

interface FocusReturner {
  request: (request: FocusReturn) => void;
  deliver: (tree: FileTreeApi, viewport: RefObject<HTMLElement | null>) => void;
  cancel: () => void;
}

function mountedRowElement(tree: FileTreeApi, rowIndex: number): HTMLElement | null {
  return rowIndex < 0 ? null : document.getElementById(tree.rowBindings.rowId(rowIndex));
}

function focusWithoutScrolling(tree: FileTreeApi, path: string, viewport: HTMLElement | null): void {
  const target =
    mountedRowElement(tree, tree.index.indexOf(path)) ??
    mountedRowElement(tree, tree.tabbableIndex) ??
    viewport;
  target?.focus({ preventScroll: true });
}

function focusTheReturnTarget(tree: FileTreeApi, request: FocusReturn, rowIsVisible: boolean): void {
  if (request.returnFocusTo?.isConnected) request.returnFocusTo.focus();
  else if (rowIsVisible) tree.focus(request.path);
}

function createFocusReturner(): FocusReturner {
  let pending: FocusReturn | null = null;
  const scheduled = new Map<ReturnType<typeof setTimeout>, FocusReturn>();
  return {
    request: (request) => {
      pending = request;
    },
    deliver: (tree, viewport) => {
      const request = pending;
      if (!request) return;
      const rowIsVisible = tree.index.indexOf(request.path) >= 0;
      if (!rowIsVisible && request.waitForRowToAppear) return;
      pending = null;
      const timer = setTimeout(() => {
        scheduled.delete(timer);
        const how = request.focus ?? 'returnToTheRow';
        if (how !== 'leaveWhereTheUserPutIt' && focusIsInsideOrNowhere(viewport.current)) {
          if (how === 'returnWithoutScrolling') focusWithoutScrolling(tree, request.path, viewport.current);
          else focusTheReturnTarget(tree, request, rowIsVisible);
        }
        request.afterFocusReturns?.();
      });
      scheduled.set(timer, request);
    },
    cancel: () => {
      pending = null;
      for (const [timer, request] of scheduled) {
        clearTimeout(timer);
        request.ifCancelled?.();
      }
      scheduled.clear();
    },
  };
}

interface CreateRequest {
  entryKind: EntryKind;
  parent: string;
  name: string;
  returnTo: string;
  returnFocusTo?: HTMLElement;
}

function createAndReveal(
  fs: FileSystemContext,
  tree: FileTreeApi,
  request: CreateRequest,
  returnFocus: (request: FocusReturn) => void,
): void {
  const { entryKind, parent, name, returnTo, returnFocusTo } = request;
  const createdPath = joinPath(parent, name);
  const previousSelection = fs.selected.get();
  if (parent !== fs.root) tree.expand(parent);
  fs.selected.set(createdPath);
  fs.store.create(parent, name, entryKind).catch((error: unknown) => {
    const fsError = toFsError(error);
    fs.notify({
      kind: 'error',
      message: failureMessage(`Could not create "${name}"`, fsError),
      error: fsError,
    });
    fs.selected.set((current) => (current === createdPath ? previousSelection : current));
    returnFocus({ path: returnTo, returnFocusTo });
  });
}

function entryOfVisibleRow(tree: FileTreeApi, path: string): Entry | undefined {
  const rowIndex = tree.index.indexOf(path);
  return rowIndex < 0 ? undefined : tree.index.rowAt(rowIndex).entry;
}

function useAnswerPendingConfirmOnUnmount(
  overlayStore: TreeActions['overlay'],
  focusReturner: FocusReturner,
): void {
  useEffect(
    () => () => {
      focusReturner.cancel();
      const overlay = overlayStore.get();
      if (overlay?.kind === 'confirm') overlay.answer(false);
    },
    [overlayStore, focusReturner],
  );
}

const scrollMoves = (target: EventTarget | null, element: HTMLElement | null): boolean =>
  target === document || (target instanceof Node && element !== null && target.contains(element));

function useMenuClosedWhenItsRowScrolls(
  menuPath: string | null,
  viewport: RefObject<HTMLElement | null>,
  overlayStore: TreeActions['overlay'],
  focusReturner: FocusReturner,
): void {
  useEffect(() => {
    if (menuPath === null) return undefined;
    const closeWhenTheRowMoves = (event: Event): void => {
      if (!scrollMoves(event.target, viewport.current) || overlayStore.get() === null) return;
      overlayStore.set(null);
      focusReturner.request({ path: menuPath, focus: 'returnWithoutScrolling' });
    };
    document.addEventListener('scroll', closeWhenTheRowMoves, true);
    return () => document.removeEventListener('scroll', closeWhenTheRowMoves, true);
  }, [menuPath, viewport, overlayStore, focusReturner]);
}

function useConflictHost(conflicts: ConflictQueue, hasOwnOverlay: boolean): ConflictRequest | undefined {
  const [host] = useState(() => ({}));
  useEffect(() => conflicts.attachHost(host), [conflicts, host]);
  useEffect(() => conflicts.setHostBusy(host, hasOwnOverlay), [conflicts, host, hasOwnOverlay]);
  const isTheShowingHost = useUiValue(conflicts.hosts)[0] === host;
  const someHostIsBusy = useUiValue(conflicts.busyHosts).size > 0;
  const waiting = useUiValue(conflicts.requests);
  return isTheShowingHost && !someHostIsBusy ? waiting[0] : undefined;
}

function useFocusReturnedWhenOverlaysClose(
  overlayStore: TreeActions['overlay'],
  overlay: TreeOverlay | null,
  tree: FileTreeApi,
  viewport: RefObject<HTMLElement | null>,
): FocusReturner {
  const [focusReturner] = useState(createFocusReturner);
  useEffect(() => {
    if (overlay === null) focusReturner.deliver(tree, viewport);
  });
  useAnswerPendingConfirmOnUnmount(overlayStore, focusReturner);
  useMenuClosedWhenItsRowScrolls(
    overlay?.kind === 'menu' ? overlay.path : null,
    viewport,
    overlayStore,
    focusReturner,
  );
  return focusReturner;
}

interface MenuOfAVisibleRow {
  entry: Entry;
  actions: Action[];
}

function useMenuOfAVisibleRow(
  overlay: TreeOverlay | null,
  tree: FileTreeApi,
  treeActions: TreeActions,
): MenuOfAVisibleRow | null {
  const menuEntry = overlay?.kind === 'menu' ? entryOfVisibleRow(tree, overlay.path) : undefined;
  const menuActions = menuEntry ? treeActions.visibleFor(menuEntry) : [];
  const menuHasNothingToShow = overlay?.kind === 'menu' && menuActions.length === 0;
  useEffect(() => {
    if (menuHasNothingToShow) treeActions.overlay.set(null);
  }, [menuHasNothingToShow, treeActions.overlay]);
  return menuEntry && menuActions.length > 0 ? { entry: menuEntry, actions: menuActions } : null;
}

interface OverlayClosing {
  close: (request: FocusReturn) => void;
  noteMenuInteractionOutside: () => void;
  closeMenu: (path: string) => void;
}

function useOverlayClosing(
  overlayStore: TreeActions['overlay'],
  focusReturner: FocusReturner,
): OverlayClosing {
  const menuClosedFromOutside = useRef(false);
  const close = (request: FocusReturn): void => {
    menuClosedFromOutside.current = false;
    if (overlayStore.get() === null) return;
    overlayStore.set(null);
    focusReturner.request(request);
  };
  return {
    close,
    noteMenuInteractionOutside: () => {
      menuClosedFromOutside.current = true;
    },
    closeMenu: (path) =>
      close({ path, focus: menuClosedFromOutside.current ? 'leaveWhereTheUserPutIt' : 'returnToTheRow' }),
  };
}

function answerConflict(
  host: { conflicts: ConflictQueue; tree: FileTreeApi; focusReturner: FocusReturner },
  request: ConflictRequest,
  answer: ConflictAnswer | null,
): void {
  const { conflicts, tree, focusReturner } = host;
  conflicts.dismiss(request);
  const returnTo = tree.focusedPath;
  const anotherConflictIsWaiting = conflicts.requests.get().length > 0;
  if (returnTo === null || anotherConflictIsWaiting) return request.settle(answer);
  focusReturner.request({
    path: returnTo,
    afterFocusReturns: () => request.settle(answer),
    ifCancelled: () => request.settle(null),
  });
}

/**
 * Props of `TreeActionOverlays`.
 *
 * @example
 * ```tsx
 * const props: TreeActionOverlaysProps = {
 *   treeActions,
 *   tree,
 *   viewport: viewportRef,
 *   components,
 *   classNames,
 * };
 * ```
 */
export interface TreeActionOverlaysProps {
  treeActions: TreeActions;
  tree: FileTreeApi;
  /** The tree's scroll viewport; focus left inside it is returned to the row. */
  viewport: RefObject<HTMLElement | null>;
  components?: Components;
  classNames?: ClassNames;
}

/**
 * Renders the tree's open menu or dialog through the `Menu` and `Dialog` slots. When it closes, focus returns
 * to the row it was opened from, or the element outside the tree that opened it (or to a newly created
 * entry), unless the user moved focus elsewhere or closed the menu by interacting outside it; only then does
 * the chosen action run. A menu also closes when the tree (or a page area around it) scrolls, since its
 * anchor no longer points at the row; focus then returns to that row (or the tree's tab stop) without
 * scrolling it back into view. Its state lives here, not in the rows, so opening a menu re-renders no row. A
 * menu whose row disappears, or that no longer has any action, closes. Unmounting cancels a pending focus
 * return and answers an open confirmation with `false`.
 *
 * It also hosts the provider's conflict dialog while no tree of the provider has a menu or other dialog open
 * (the first mounted tree shows it). An answer is delivered once focus is back on the focused row, unless
 * another conflict is already waiting; unmounting answers the open and the waiting conflicts with `null`,
 * unless another tree takes them over.
 *
 * @example
 * ```tsx
 * <TreeActionOverlays treeActions={treeActions} tree={tree} viewport={viewportRef} />
 * ```
 */
export function TreeActionOverlays(props: TreeActionOverlaysProps): React.JSX.Element | null {
  const { treeActions, tree, viewport, components, classNames } = props;
  const fs = useFileSystem();
  const overlay = useUiValue(treeActions.overlay);
  const focusReturner = useFocusReturnedWhenOverlaysClose(treeActions.overlay, overlay, tree, viewport);
  const { conflicts } = internalsOf(fs);
  const conflict = useConflictHost(conflicts, overlay !== null);
  const menu = useMenuOfAVisibleRow(overlay, tree, treeActions);
  const closing = useOverlayClosing(treeActions.overlay, focusReturner);
  const Dialog = components?.Dialog ?? DefaultDialog;
  if (!overlay) {
    if (!conflict) return null;
    return (
      <ConflictDialog
        key={conflict.id}
        kind={conflict.kind}
        path={conflict.path}
        remaining={conflict.remaining}
        existing={conflict.existing}
        offersReplace={conflict.offersReplace}
        Dialog={Dialog}
        classNames={classNames}
        onAnswer={(answer) => answerConflict({ conflicts, tree, focusReturner }, conflict, answer)}
      />
    );
  }
  return (
    <OpenOverlay
      overlay={overlay}
      menu={menu}
      closing={closing}
      run={treeActions.run}
      createAndReveal={(request) => createAndReveal(fs, tree, request, focusReturner.request)}
      Menu={components?.Menu ?? DefaultMenu}
      Dialog={Dialog}
      classNames={classNames}
    />
  );
}

interface OpenOverlayProps {
  overlay: TreeOverlay;
  menu: MenuOfAVisibleRow | null;
  closing: OverlayClosing;
  run: TreeActions['run'];
  createAndReveal: (request: CreateRequest) => void;
  Menu: NonNullable<Components['Menu']>;
  Dialog: NonNullable<Components['Dialog']>;
  classNames?: ClassNames;
}

function OpenOverlay(props: OpenOverlayProps): React.JSX.Element | null {
  const { overlay, menu, closing, run, Menu, Dialog, classNames } = props;
  const { close } = closing;
  switch (overlay.kind) {
    case 'menu': {
      if (!menu) return null;
      const { entry } = menu;
      return (
        <ActionMenu
          entry={entry}
          actions={menu.actions}
          anchor={overlay.anchor}
          Menu={Menu}
          classNames={classNames}
          onSelect={(action) => close({ path: overlay.path, afterFocusReturns: () => run(action, entry) })}
          onInteractOutside={closing.noteMenuInteractionOutside}
          onClose={() => closing.closeMenu(overlay.path)}
        />
      );
    }
    case 'create':
      return (
        <CreateDialog
          kind={overlay.entryKind}
          parent={overlay.parent}
          Dialog={Dialog}
          classNames={classNames}
          onCancel={() => close({ path: overlay.returnTo, returnFocusTo: overlay.returnFocusTo })}
          onCreate={(name) => {
            close({ path: joinPath(overlay.parent, name), waitForRowToAppear: true });
            props.createAndReveal({ ...overlay, name });
          }}
        />
      );
    case 'confirm':
      return (
        <ConfirmDialog
          request={overlay.request}
          Dialog={Dialog}
          classNames={classNames}
          onAnswer={(confirmed) =>
            close({
              path: overlay.returnTo,
              returnFocusTo: overlay.returnFocusTo,
              afterFocusReturns: () => overlay.answer(confirmed),
              ifCancelled: () => overlay.answer(false),
            })
          }
        />
      );
  }
}
