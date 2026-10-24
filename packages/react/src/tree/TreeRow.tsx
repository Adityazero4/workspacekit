'use client';
import { type Entry, type FolderStatus } from '@workspacekit/core';
import { docsLink } from '@workspacekit/core/docs';
import {
  createContext,
  memo,
  use,
  useId,
  type Context,
  type HTMLAttributes,
  type NamedExoticComponent,
  type ReactNode,
} from 'react';
import { useIsCut } from '../actions/clipboard';
import { anchorBelow } from '../actions/useTreeActions';
import type { MenuAnchor } from '../components';
import { partProps } from '../cx';
import { useIsInDropTarget, type TreeDragHandlers } from '../dnd/useTreeDnd';
import { Icons } from '../icons';
import { useEntryState, useExpanded, useSelected, type EntryState } from '../provider/hooks';
import type { UiStore } from '../provider/ui-store';
import type { FileTreeProps } from './FileTree';
import { useRenameSession, type InlineRename, type RenameSession } from './inlineRename';
import { RenameInput } from './RenameInput';
import { useIsFlashing } from './revealHost';
import type { TreeRowBindings } from './rovingFocus';
import { treeRowAttributes, treeRowFocusHandlers } from './useFileTree';

/**
 * What every row of one `FileTree` shares. `FileTree` keeps its identity stable while the slots and callbacks
 * are unchanged, so a selection, focus or tree change re-renders only the rows it concerns.
 *
 * @example
 * ```tsx
 * <TreeRowContext value={{ bindings: tree.rowBindings, activate, openFile }}>{rows}</TreeRowContext>
 * ```
 */
export type TreeRowShared = Pick<
  FileTreeProps,
  'classNames' | 'renderIcon' | 'renderBadge' | 'renderTrailing'
> & {
  bindings: TreeRowBindings;
  /** A click on the row; `clickCount` is the event's `detail` (2 for the second click of a double click). */
  activate: (entry: Entry, clickCount: number) => void;
  openFile: (entry: Entry, how: 'preview' | 'pin') => void;
  /**
   * Opens the entry's action menu at `anchor` unless no action applies; returns whether it opened.
   * Identity-stable.
   */
  openMenu: (entry: Entry, anchor: MenuAnchor) => boolean;
  /** The tree's rename state; each row subscribes to its own session. */
  inlineRename: InlineRename;
  /** The path a reveal is flashing; each row subscribes to whether it is its own. */
  flashing: UiStore<string | null>;
  /** Whether rows can be dragged: the adapter can move or copy. */
  draggable: boolean;
  /** The tree's drag and drop handlers; each row subscribes to the drop target for its own state. */
  drag: TreeDragHandlers;
};

/**
 * Provides `TreeRowShared` to the rows of one `FileTree`.
 *
 * @example
 * ```tsx
 * <TreeRowContext value={shared}>{rows}</TreeRowContext>
 * ```
 */
export const TreeRowContext: Context<TreeRowShared | null> = createContext<TreeRowShared | null>(null);

/**
 * Props of `TreeRow`: primitives only, so the memoized row re-renders only when one of them changes.
 *
 * @example
 * ```tsx
 * const props: TreeRowViewProps = { path: 'a.txt', rowIndex: 0, offset: 0, depth: 0, setSize: 1, posInSet: 1,
 *   isTabStop: true, isFocused: false };
 * ```
 */
export interface TreeRowViewProps {
  path: string;
  rowIndex: number;
  /** The row's top in pixels, from the virtualizer. */
  offset: number;
  depth: number;
  setSize: number;
  posInSet: number;
  isTabStop: boolean;
  isFocused: boolean;
}

/**
 * One virtualized tree row: chevron, icon, label (or the rename input), badge and trailing slots, the More
 * actions button, plus the cut, changed, changed-below, pending, drop-target and loading/error markers.
 * Memoized; it reads its entry, selection, expansion, cut, rename, drop-target and flash state through
 * per-path selectors. The row is draggable (except while being renamed) and a drop target. The More actions
 * button is not a tab stop (the tree keeps one); keyboard users open the same menu with Shift+F10 or the
 * ContextMenu key.
 *
 * @example
 * ```tsx
 * const slot = layout.slotAt(item.index);
 * <TreeRow key={row.path} path={row.path} rowIndex={slot.rowIndex} offset={item.start} depth={row.depth}
 *   setSize={row.setSize} posInSet={row.posInSet} isTabStop={false} isFocused={false} />
 * ```
 */
export const TreeRow: NamedExoticComponent<TreeRowViewProps> = memo(function TreeRow(
  props: TreeRowViewProps,
) {
  const { path, rowIndex, offset, depth, setSize, posInSet, isTabStop, isFocused } = props;
  const shared = useTreeRowShared();
  const state = useEntryState(path);
  const isSelected = useSelected(path);
  const isExpanded = useExpanded(path);
  const isCut = useIsCut(path);
  const renameSession = useRenameSession(shared.inlineRename, path);
  const isDropTarget = useIsInDropTarget(shared.drag.dropTarget, path);
  const isFlashing = useIsFlashing(shared.flashing, path);
  const errorDescriptionId = useId();
  const { entry } = state;
  if (!entry) return null;
  const isFile = entry.kind === 'file';

  return (
    <div
      {...treeRowAttributes({
        id: shared.bindings.rowId(rowIndex),
        depth,
        setSize,
        posInSet,
        isDirectory: !isFile,
        isExpanded: !isFile && isExpanded,
        isSelected,
        isTabStop,
        isFocused,
      })}
      {...treeRowFocusHandlers(shared.bindings, path)}
      {...partProps('tree-row', shared.classNames)}
      {...rowStateMarkers(state, { isCut, isDropTarget, isFlashing })}
      aria-describedby={state.error ? errorDescriptionId : undefined}
      style={{
        transform: `translateY(${offset}px)`,
        paddingInlineStart: `calc(${depth} * var(--fs-indent))`,
      }}
      {...rowPointerAndDragHandlers(shared, entry)}
      draggable={shared.draggable && !renameSession}
    >
      <TreeRowContent
        entry={entry}
        state={state}
        isExpanded={isExpanded}
        renameSession={renameSession}
        errorDescriptionId={errorDescriptionId}
      />
    </div>
  );
});

interface RowStateMarkers {
  'data-cut': '' | undefined;
  'data-changed': '' | undefined;
  'data-changed-below': '' | undefined;
  'data-pending': '' | undefined;
  'data-drop-target': '' | undefined;
  'data-flash': '' | undefined;
  'data-status': 'loading' | 'error' | undefined;
  'aria-busy': true | undefined;
}

function rowStateMarkers(
  state: EntryState,
  flags: { isCut: boolean; isDropTarget: boolean; isFlashing: boolean },
): RowStateMarkers {
  return {
    'data-cut': flags.isCut ? '' : undefined,
    'data-changed': state.changed ? '' : undefined,
    'data-changed-below': state.changedBelow ? '' : undefined,
    'data-pending': state.pending ? '' : undefined,
    'data-drop-target': flags.isDropTarget ? '' : undefined,
    'data-flash': flags.isFlashing ? '' : undefined,
    'data-status': state.status === 'loading' || state.status === 'error' ? state.status : undefined,
    'aria-busy': state.status === 'loading' ? true : undefined,
  };
}

function rowPointerAndDragHandlers(shared: TreeRowShared, entry: Entry): HTMLAttributes<HTMLDivElement> {
  return {
    onClick: (event) => shared.activate(entry, event.detail),
    onDoubleClick: () => {
      if (entry.kind === 'file') shared.openFile(entry, 'pin');
    },
    onContextMenu: (event) => {
      if (shared.openMenu(entry, { x: event.clientX, y: event.clientY })) event.preventDefault();
    },
    onDragStart: (event) => shared.drag.dragStart(event, entry),
    onDragOver: (event) => shared.drag.dragOver(event, entry),
    onDrop: (event) => shared.drag.drop(event, entry),
  };
}

interface TreeRowContentProps {
  entry: Entry;
  state: EntryState;
  isExpanded: boolean;
  renameSession: RenameSession | null;
  errorDescriptionId: string;
}

function TreeRowContent(props: TreeRowContentProps): React.JSX.Element {
  const { entry, state, isExpanded, renameSession, errorDescriptionId } = props;
  const shared = useTreeRowShared();
  const { classNames } = shared;
  const isFile = entry.kind === 'file';
  const icon =
    statusIcon(state.status) ??
    (shared.renderIcon ? shared.renderIcon(entry, { expanded: isExpanded }) : defaultIcon(entry, isExpanded));
  return (
    <>
      <span {...partProps('tree-chevron', classNames)} aria-hidden="true">
        {!isFile && <Icons.Chevron />}
      </span>
      <span {...partProps('tree-row-icon', classNames)}>{icon}</span>
      {renameSession ? (
        <RenameInput
          entry={entry}
          session={renameSession}
          inlineRename={shared.inlineRename}
          classNames={classNames}
        />
      ) : (
        <span {...partProps('tree-row-label', classNames)}>{entry.name}</span>
      )}
      {shared.renderBadge && (
        <span {...partProps('tree-badge', classNames)}>{shared.renderBadge(entry)}</span>
      )}
      {shared.renderTrailing && (
        <span {...partProps('tree-trailing', classNames)}>{shared.renderTrailing(entry)}</span>
      )}
      <RowMoreActionsButton entry={entry} />
      {state.error && (
        <span {...partProps('tree-row-error', classNames)} id={errorDescriptionId} hidden>
          {state.error.message}
        </span>
      )}
    </>
  );
}

function RowMoreActionsButton(props: { entry: Entry }): React.JSX.Element {
  const { entry } = props;
  const shared = useTreeRowShared();
  return (
    <button
      type="button"
      {...partProps('tree-row-more', shared.classNames)}
      tabIndex={-1}
      aria-hidden="true"
      title="More actions"
      onClick={(event) => {
        event.stopPropagation();
        shared.openMenu(entry, anchorBelow(event.currentTarget));
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icons.More />
    </button>
  );
}

function useTreeRowShared(): TreeRowShared {
  const shared = use(TreeRowContext);
  if (!shared) {
    throw new Error(
      'A tree row was rendered outside <FileTree>. Render tree rows only inside <FileTree>, which provides the ' +
        `state they share. See ${docsLink('concepts/adapter', 'tree-rows-and-tabs')}`,
    );
  }
  return shared;
}

function statusIcon(status: FolderStatus): ReactNode {
  if (status === 'loading') return <Icons.Spinner />;
  if (status === 'error') return <Icons.Alert />;
  return null;
}

function defaultIcon(entry: Entry, expanded: boolean): ReactNode {
  if (entry.kind === 'file') return <Icons.File />;
  return expanded ? <Icons.FolderOpen /> : <Icons.Folder />;
}
