'use client';
import {
  createVisibleRowIndex,
  entryAt,
  type Entry,
  type SortSpec,
  type TreeData,
  type VisibleRow,
  type VisibleRowIndex,
} from '@scope/core';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type RefCallback,
} from 'react';
import { useFileSystem, useTreeSnapshot, useUiValue, type FileSystemContext } from '../provider/hooks';
import type { RevealOptions } from '../provider/reveal';
import { withMembership, type UiStore } from '../provider/ui-store';
import { createInlineRename, type InlineRename } from './inlineRename';
import { isMac, treeKeyIntent, type TreeKeyIntent } from './keyboard';
import { useRevealHost } from './revealHost';
import { useRovingFocus, type RovingFocus, type TreeRowBindings } from './rovingFocus';
import { findTypeahead, typeaheadStep, type TypeaheadState } from './typeahead';

/**
 * Options for `useFileTree`.
 *
 * @example
 * ```tsx
 * const tree = useFileTree({ rowHeight: 28, onOpenFile: (entry) => openTab(entry.path) });
 * ```
 */
export interface UseFileTreeOptions {
  /** Called on Enter / double-click / single-click on a file. */
  onOpenFile?: (entry: Entry, how: 'preview' | 'pin') => void;
  /** Row height in pixels. Default: 32, or 44 when the primary pointer is coarse (touch). */
  rowHeight?: number;
}

/**
 * Props for one rendered row; spread them onto the row element.
 *
 * @example
 * ```tsx
 * <div {...tree.getRowProps(row)}>{row.entry.name}</div>
 * ```
 */
export type TreeRowProps = HTMLAttributes<HTMLElement> & {
  role: 'treeitem';
  id: string;
  tabIndex: 0 | -1;
  'aria-level': number;
  'aria-setsize': number;
  'aria-posinset': number;
  'aria-expanded'?: boolean;
  'aria-selected': boolean;
  'data-fs-part': 'tree-row';
  'data-selected'?: '';
  'data-expanded'?: '';
  'data-focused'?: '';
  /** Registers the row element, so `focus(path)` can focus it once it is rendered. */
  ref: RefCallback<HTMLElement>;
};

/**
 * Props for the tree container; spread them onto the element that wraps the rows.
 *
 * @example
 * ```tsx
 * <div {...tree.getTreeProps()}>{rows}</div>
 * ```
 */
export type TreeProps = HTMLAttributes<HTMLElement> & {
  role: 'tree';
  'aria-label': string;
  'data-fs-part': 'tree';
  onKeyDown: KeyboardEventHandler;
  onFocus: FocusEventHandler;
  onBlur: FocusEventHandler;
};

/**
 * What `useFileTree` returns: the visible rows, focus state, prop getters and tree commands.
 *
 * @example
 * ```tsx
 * const { index, getRowProps, focus }: FileTreeApi = useFileTree();
 * ```
 */
export interface FileTreeApi {
  /**
   * The visible rows: `count`, `rowAt`, `indexOf`, `ancestorsAt`. Reused while the tree and UI state are
   * unchanged.
   */
  index: VisibleRowIndex;
  /**
   * The row that last had keyboard focus (or was focused through `focus`), kept after focus leaves the tree.
   */
  focusedPath: string | null;
  /** Whether DOM focus is inside the tree; `data-focused` marks `focusedPath` only while it is. */
  treeHasFocus: boolean;
  /**
   * The row index holding the tree's single tab stop (the focused row, else the selected row, else the first
   * row), or -1 when the tree is empty. A virtualizer must always render this row, or the tree cannot be
   * reached with Tab.
   */
  tabbableIndex: number;
  /** The resolved row height: the `rowHeight` option or the pointer-based default. */
  rowHeight: number;
  /** Props for the tree container: role, label, keyboard handling and focus tracking. */
  getTreeProps: () => TreeProps;
  /** Props for one row: ARIA attributes, state attributes, roving tabindex and the element ref. */
  getRowProps: (row: VisibleRow) => TreeRowProps;
  /**
   * Identity-stable row handlers, for a renderer that memoizes its rows and builds their props from
   * primitives instead of calling `getRowProps` on every render.
   */
  rowBindings: TreeRowBindings;
  /** Expands a collapsed folder or collapses an expanded one. */
  toggle: (path: string) => void;
  /** Expands a folder; the provider loads it if needed. */
  expand: (path: string) => void;
  /** Collapses a folder. */
  collapse: (path: string) => void;
  /** Collapses every folder. */
  collapseAll: () => void;
  /** What Enter does: opens a file (pinned) through `onOpenFile`, or toggles a folder. */
  open: (entry: Entry) => void;
  /** The path whose name is being edited inline, or `null`. */
  renaming: string | null;
  /** Starts the inline rename of `path`. */
  startRename: (path: string) => void;
  /**
   * Scrolls the row into view first (via the registered `scrollToIndex`), then focuses it once it is
   * rendered. Does nothing for a row that is not visible (collapsed away, hidden or not loaded), and cancels
   * any earlier focus request still waiting for its row to mount.
   */
  focus: (path: string) => void;
  /**
   * The renderer registers its virtualizer's `scrollToIndex`, so `focus` can reach rows outside the rendered
   * window.
   */
  setScrollToIndex: (fn: (index: number) => void) => void;
  /**
   * The provider's `reveal` (see `FileSystemContext.reveal`): loads and expands every folder above `path`,
   * selects it, then scrolls its row into view and focuses it (`focus: false` leaves focus where it is);
   * `flash` marks it `data-flash` (`FileTree` renders that). Rejects with `FsError` `cancelled` when a later
   * reveal replaces it, and with `not_found` when the path does not exist.
   */
  reveal: (path: string, opts?: RevealOptions) => Promise<void>;
}

/**
 * The headless tree: a visible-row index over the provider's tree (hidden names filtered unless Show hidden
 * is on), the WAI-ARIA keyboard model with a roving tabindex and type-ahead, and prop getters for a renderer.
 *
 * The renderer virtualizes `index`, registers its `scrollToIndex` so focus can reach rows outside the
 * rendered window, and always renders `tabbableIndex` so the tree keeps its single tab stop (and the focused
 * row keeps focus while scrolled away). When the focused row is removed while it has focus (deleted, moved,
 * collapsed away or hidden), focus moves to the row now at its index, or the last row. Rename, delete,
 * context-menu and clipboard keys are recognized but not acted on here: the renderer maps them to actions
 * (`FileTree` does). `startRename` only records the row being renamed; the renderer shows the input and keeps
 * that row rendered.
 *
 * @example
 * ```tsx
 * function MyTree(): React.JSX.Element {
 *   const tree = useFileTree({ onOpenFile: (entry, how) => openTab(entry.path, how) });
 *   const scrollRef = useRef<HTMLDivElement>(null);
 *   const virtualizer = useVirtualizer({
 *     count: tree.index.count,
 *     estimateSize: () => tree.rowHeight,
 *     getScrollElement: () => scrollRef.current,
 *     rangeExtractor: (range) => {
 *       const indexes = defaultRangeExtractor(range);
 *       const tabStop = tree.tabbableIndex;
 *       if (tabStop >= 0 && !indexes.includes(tabStop)) indexes.push(tabStop);
 *       return indexes.sort((a, b) => a - b);
 *     },
 *   });
 *   useEffect(() => tree.setScrollToIndex((index) => virtualizer.scrollToIndex(index)));
 *   return (
 *     <div ref={scrollRef} style={{ height: 400, overflow: 'auto' }}>
 *       <div {...tree.getTreeProps()} style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
 *         {virtualizer.getVirtualItems().map((item) => {
 *           const row = tree.index.rowAt(item.index);
 *           return (
 *             <div
 *               key={row.path}
 *               {...tree.getRowProps(row)}
 *               style={{
 *                 position: 'absolute',
 *                 top: item.start,
 *                 height: item.size,
 *                 width: '100%',
 *                 paddingInlineStart: row.depth * 16,
 *               }}
 *             >
 *               {row.entry.name}
 *             </div>
 *           );
 *         })}
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useFileTree(options: UseFileTreeOptions = {}): FileTreeApi {
  return useFileTreeWithInlineRename(options).tree;
}

/**
 * `useFileTree` plus the identity-stable stores `FileTree` shares with its memoized rows: the rename state
 * behind `renaming` and `startRename`, and the path a reveal is flashing. A move of the renaming entry or a
 * folder above it carries the rename to the new path with what was typed; a rename whose entry leaves the
 * tree (deleted, or moved into a folder that is not loaded) ends, without moving focus.
 *
 * @example
 * ```tsx
 * const { tree, inlineRename, flashing } = useFileTreeWithInlineRename({ rowHeight: 28 });
 * ```
 */
export function useFileTreeWithInlineRename(options: UseFileTreeOptions): {
  tree: FileTreeApi;
  inlineRename: InlineRename;
  flashing: UiStore<string | null>;
} {
  const fs = useFileSystem();
  const { tree } = useTreeSnapshot();
  const expanded = useUiValue(fs.expanded);
  const selected = useUiValue(fs.selected);
  const sort = useUiValue(fs.sort);
  const hide = useUiValue(fs.showHidden) ? undefined : stableHidePredicateFor(fs.hiddenNames);
  const isCoarsePointer = useSyncExternalStore(subscribeToPointer, readCoarsePointer, coarsePointerOnServer);
  const index = useIndexRebuiltWhenInputIdentityChanges({ tree, root: fs.root, expanded, sort, hide });
  const rovingFocus = useRovingFocus(index);
  const flashing = useRevealHost(fs, rovingFocus.controller);
  const commands = expansionCommands(fs.expanded);
  const open = (entry: Entry): void => {
    if (entry.kind === 'directory') commands.toggle(entry.path);
    else options.onOpenFile?.(entry, 'pin');
  };
  const onKeyDown = useTreeKeyboard({ index, tree, hide, fs, rovingFocus, commands, open });
  const [inlineRename] = useState(() => createInlineRename(rovingFocus.controller));
  const renaming = useUiValue(inlineRename.session)?.path ?? null;
  useLayoutEffect(() => {
    if (renaming !== null && !entryAt(tree, renaming)) inlineRename.end(null);
  }, [tree, renaming, inlineRename]);
  useEffect(() => fs.store.onMove(inlineRename.followMove), [fs.store, inlineRename]);

  const { focusedPath, treeHasFocus, controller } = rovingFocus;
  const tabbableIndex = tabStopIndex(index, focusedPath, selected);
  const api: FileTreeApi = {
    index,
    focusedPath,
    treeHasFocus,
    tabbableIndex,
    rowHeight: options.rowHeight ?? (isCoarsePointer ? 44 : 32),
    getTreeProps: () => treeProps(onKeyDown, rovingFocus),
    getRowProps: (row) => {
      const rowIndex = index.indexOf(row.path);
      return {
        ...treeRowAttributes({
          id: controller.bindings.rowId(rowIndex),
          depth: row.depth,
          setSize: row.setSize,
          posInSet: row.posInSet,
          isDirectory: row.entry.kind === 'directory',
          isExpanded: row.isExpanded,
          isSelected: selected === row.path,
          isTabStop: rowIndex === tabbableIndex,
          isFocused: treeHasFocus && focusedPath === row.path,
        }),
        ...treeRowFocusHandlers(controller.bindings, row.path),
      };
    },
    rowBindings: controller.bindings,
    ...commands,
    collapseAll: () => fs.expanded.set(new Set()),
    open,
    renaming,
    startRename: (path) => inlineRename.start(path),
    focus: (path) => controller.focusPathIn(index, path),
    setScrollToIndex: controller.setScrollToIndex,
    reveal: fs.reveal,
  };
  return { tree: api, inlineRename, flashing };
}

type HidePredicate = (entry: Entry) => boolean;

const hidePredicatePerNameSet = new WeakMap<ReadonlySet<string>, HidePredicate>();
function stableHidePredicateFor(hiddenNames: ReadonlySet<string>): HidePredicate {
  let hide = hidePredicatePerNameSet.get(hiddenNames);
  if (!hide) hidePredicatePerNameSet.set(hiddenNames, (hide = (entry) => hiddenNames.has(entry.name)));
  return hide;
}

const COARSE_POINTER = '(pointer: coarse)';
function subscribeToPointer(onChange: () => void): () => void {
  const query = matchMedia(COARSE_POINTER);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const readCoarsePointer = (): boolean => matchMedia(COARSE_POINTER).matches;
const coarsePointerOnServer = (): boolean => false;

interface InputsWhoseIdentityRebuildsTheIndex {
  tree: TreeData;
  root: string;
  expanded: ReadonlySet<string>;
  sort: SortSpec;
  hide: HidePredicate | undefined;
}
interface IndexState extends InputsWhoseIdentityRebuildsTheIndex {
  index: VisibleRowIndex;
}
function buildIndexState(
  inputs: InputsWhoseIdentityRebuildsTheIndex,
  previous?: VisibleRowIndex,
): IndexState {
  const { tree, ...options } = inputs;
  return { ...inputs, index: createVisibleRowIndex(tree, options, previous) };
}
function hasSameInputs(state: IndexState, inputs: InputsWhoseIdentityRebuildsTheIndex): boolean {
  return (
    state.tree === inputs.tree &&
    state.root === inputs.root &&
    state.expanded === inputs.expanded &&
    state.sort === inputs.sort &&
    state.hide === inputs.hide
  );
}

function useIndexRebuiltWhenInputIdentityChanges(
  inputs: InputsWhoseIdentityRebuildsTheIndex,
): VisibleRowIndex {
  const [indexState, setIndexState] = useState(() => buildIndexState(inputs));
  if (hasSameInputs(indexState, inputs)) return indexState.index;
  const rebuilt = buildIndexState(inputs, indexState.index);
  setIndexState(rebuilt);
  return rebuilt.index;
}

function tabStopIndex(index: VisibleRowIndex, focusedPath: string | null, selected: string | null): number {
  const focusedIndex = focusedPath === null ? -1 : index.indexOf(focusedPath);
  if (focusedIndex >= 0) return focusedIndex;
  const selectedIndex = selected === null ? -1 : index.indexOf(selected);
  if (selectedIndex >= 0) return selectedIndex;
  return index.count > 0 ? 0 : -1;
}

interface ExpansionCommands {
  expand: (path: string) => void;
  collapse: (path: string) => void;
  toggle: (path: string) => void;
}

function expansionCommands(expandedStore: UiStore<ReadonlySet<string>>): ExpansionCommands {
  const setExpanded = (path: string, open: boolean): void =>
    expandedStore.set((previous) => withMembership(previous, [path], open));
  return {
    expand: (path) => setExpanded(path, true),
    collapse: (path) => setExpanded(path, false),
    toggle: (path) => setExpanded(path, !expandedStore.get().has(path)),
  };
}

interface TreeKeyboardContext {
  index: VisibleRowIndex;
  tree: TreeData;
  hide: HidePredicate | undefined;
  fs: FileSystemContext;
  rovingFocus: RovingFocus;
  commands: ExpansionCommands;
  open: (entry: Entry) => void;
}

function useTreeKeyboard(context: TreeKeyboardContext): KeyboardEventHandler<HTMLElement> {
  const { index, fs, rovingFocus, commands } = context;
  const advanceTypeahead = useTypeaheadBuffer();
  const moveTo = (rowIndex: number): void => {
    const { path } = index.rowAt(rowIndex);
    rovingFocus.controller.focusPathIn(index, path);
    fs.selected.set(path);
  };
  const apply = (intent: TreeKeyIntent, row: VisibleRow, rowIndex: number): boolean => {
    switch (intent.kind) {
      case 'move':
        moveTo(intent.index);
        return true;
      case 'expand':
        commands.expand(intent.path);
        return true;
      case 'collapse':
        commands.collapse(intent.path);
        return true;
      case 'expandSiblings': {
        const folders = visibleSubfolders(context.tree, intent.parent, context.hide);
        fs.expanded.set((previous) => withMembership(previous, folders, true));
        return true;
      }
      case 'open':
        context.open(row.entry);
        return true;
      case 'typeahead': {
        const match = findTypeahead(index, rowIndex, advanceTypeahead(intent.char));
        if (match >= 0) moveTo(match);
        return true;
      }
      default:
        return false;
    }
  };
  return (event) => {
    const rowIndex = rovingFocus.controller.rowIndexOfElement(index, event.target);
    if (rowIndex < 0) return;
    const row = index.rowAt(rowIndex);
    if (apply(treeKeyIntent(event, row, index, isMac()), row, rowIndex)) event.preventDefault();
  };
}

function useTypeaheadBuffer(): (char: string) => string {
  const buffer = useRef<TypeaheadState | null>(null);
  return (char) => {
    buffer.current = typeaheadStep(buffer.current, char, performance.now());
    return buffer.current.text;
  };
}

function visibleSubfolders(tree: TreeData, parent: string, hide: HidePredicate | undefined): string[] {
  const siblings = tree.folders.get(parent)?.children.values() ?? [];
  return [...siblings]
    .filter((entry) => entry.kind === 'directory' && !hide?.(entry))
    .map((entry) => entry.path);
}

function treeProps(onKeyDown: KeyboardEventHandler, rovingFocus: RovingFocus): TreeProps {
  return {
    role: 'tree',
    'aria-label': 'Files',
    'data-fs-part': 'tree',
    onKeyDown,
    ...rovingFocus.treeFocusHandlers,
  };
}

/**
 * Everything a row's attributes depend on, as primitives, so a memoized row re-renders only when one of them
 * changes.
 *
 * @example
 * ```ts
 * const state: TreeRowState = { id, depth: 0, setSize: 3, posInSet: 1, isDirectory: false, isExpanded: false,
 *   isSelected: true, isTabStop: true, isFocused: false };
 * ```
 */
export interface TreeRowState {
  id: string;
  depth: number;
  setSize: number;
  posInSet: number;
  isDirectory: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  isTabStop: boolean;
  isFocused: boolean;
}

/**
 * A row's role, roving tabindex, ARIA and state attributes.
 *
 * @example
 * ```tsx
 * <div {...treeRowAttributes(state)} {...treeRowFocusHandlers(tree.rowBindings, path)} />
 * ```
 */
export function treeRowAttributes(state: TreeRowState): Omit<TreeRowProps, 'onFocus' | 'ref'> {
  return {
    role: 'treeitem',
    id: state.id,
    tabIndex: state.isTabStop ? 0 : -1,
    'aria-level': state.depth + 1,
    'aria-setsize': state.setSize,
    'aria-posinset': state.posInSet,
    'aria-expanded': state.isDirectory ? state.isExpanded : undefined,
    'aria-selected': state.isSelected,
    'data-fs-part': 'tree-row',
    'data-selected': state.isSelected ? '' : undefined,
    'data-expanded': state.isExpanded ? '' : undefined,
    'data-focused': state.isFocused ? '' : undefined,
  };
}

/**
 * A row's `ref` and `onFocus`, built from the identity-stable bindings.
 *
 * @example
 * ```tsx
 * <div {...treeRowFocusHandlers(tree.rowBindings, path)} />
 * ```
 */
export function treeRowFocusHandlers(
  bindings: TreeRowBindings,
  path: string,
): Pick<TreeRowProps, 'onFocus' | 'ref'> {
  return {
    ref: (element) => (element ? bindings.registerRow(path, element) : undefined),
    onFocus: (event) => {
      if (event.target === event.currentTarget) bindings.rowFocused(path);
    },
  };
}
