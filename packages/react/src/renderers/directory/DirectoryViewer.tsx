'use client';
import { sortedChildren, type Entry, type FolderStatus } from '@scope/core';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { partProps } from '../../cx';
import { useListboxWindow } from '../../listboxWindow';
import type { ClassNames } from '../../parts';
import { useFileSystem, useTreeSnapshot, useUiValue } from '../../provider/hooks';
import { viewerError, type RendererProps, type ViewerError } from '../../viewer/registry';
import { formatBytes, formatModified } from '../format';
import { useLatest } from '../useLatest';

const ESTIMATED_ROW_HEIGHT = 28;
const NO_CHILDREN: readonly Entry[] = [];

interface FolderListing {
  children: readonly Entry[];
  status: FolderStatus;
}

function useFolderListing(path: string, onError: (error: ViewerError) => void): FolderListing {
  const fs = useFileSystem();
  const { tree, errors } = useTreeSnapshot();
  const sort = useUiValue(fs.sort);
  const showHidden = useUiValue(fs.showHidden);
  const folder = tree.folders.get(path);
  const status = folder?.status ?? 'idle';
  const loadError = status === 'error' ? errors.get(path) : undefined;
  const reportError = useLatest(onError);
  useEffect(() => {
    if (status !== 'idle') return;
    fs.store
      .loadFolder(path)
      .catch((thrown: unknown) => reportError.current(viewerError('load_error', thrown)));
  }, [fs.store, path, status, reportError]);
  useEffect(() => {
    if (loadError) reportError.current(viewerError('load_error', loadError));
  }, [loadError, reportError]);
  const sorted = folder ? sortedChildren(folder, sort) : NO_CHILDREN;
  return {
    children: showHidden ? sorted : sorted.filter((child) => !fs.hiddenNames.has(child.name)),
    status,
  };
}

const statusAttribute = (status: FolderStatus): 'loading' | 'error' | undefined => {
  if (status === 'loaded') return undefined;
  return status === 'error' ? 'error' : 'loading';
};

function targetIndex(key: string, activeIndex: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return Math.min(activeIndex + 1, count - 1);
    case 'ArrowUp':
      return Math.max(activeIndex - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

function RowCells(props: { entry: Entry; classNames: ClassNames | undefined }): React.JSX.Element {
  const { entry, classNames } = props;
  return (
    <>
      <span {...partProps('dir-name', classNames)}>{entry.name}</span>
      <span {...partProps('dir-size', classNames)}>
        {entry.kind === 'file' && typeof entry.size === 'number' ? formatBytes(entry.size) : ''}
      </span>
      <span {...partProps('dir-modified', classNames)}>
        {entry.mtimeMs !== undefined && (
          <time dateTime={new Date(entry.mtimeMs).toISOString()}>{formatModified(entry.mtimeMs)}</time>
        )}
      </span>
    </>
  );
}

interface DirectoryListProps {
  entries: readonly Entry[];
  label: string;
  onOpenEntry: ((path: string) => void) | undefined;
  classNames: ClassNames | undefined;
}

function DirectoryList(props: DirectoryListProps): React.JSX.Element {
  const { entries, label, onOpenEntry, classNames } = props;
  const listboxId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [chosenIndex, setChosenIndex] = useState(0);
  const activeIndex = Math.min(chosenIndex, entries.length - 1);
  const listboxWindow = useListboxWindow(entries.length, activeIndex, viewport, ESTIMATED_ROW_HEIGHT);
  const optionId = (index: number): string => `${listboxId}-option-${index}`;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = entries.length > 0 ? targetIndex(event.key, activeIndex, entries.length) : undefined;
    if (target !== undefined) {
      setChosenIndex(target);
      listboxWindow.scrollToIndex(target);
    } else if (event.key === 'Enter' && entries[activeIndex]) {
      onOpenEntry?.(entries[activeIndex].path);
    } else return;
    event.preventDefault();
  };
  return (
    <div ref={viewport} {...partProps('dir-viewport', classNames)}>
      <div
        {...partProps('dir-list', classNames)}
        role="listbox"
        aria-label={label}
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        tabIndex={0}
        style={{ height: listboxWindow.totalSize }}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
        }}
      >
        {listboxWindow.items.map((item) => {
          const child = entries[item.index]!;
          const isActive = item.index === activeIndex;
          return (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- focus stays on the listbox, which handles the keys and points at the active option with aria-activedescendant
            <div
              key={child.path}
              ref={listboxWindow.measureElement}
              data-index={item.index}
              {...partProps('dir-row', classNames)}
              id={optionId(item.index)}
              role="option"
              aria-selected={isActive}
              aria-setsize={entries.length}
              aria-posinset={item.index + 1}
              data-selected={isActive ? '' : undefined}
              style={{ transform: `translateY(${item.start}px)` }}
              onClick={() => setChosenIndex(item.index)}
              onDoubleClick={() => onOpenEntry?.(child.path)}
            >
              <RowCells entry={child} classNames={classNames} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The directory renderer component the registry loads: the folder's children from the provider's tree
 * (loading the folder when needed), sorted and filtered like the tree, with name, size and modified
 * columns. The list is a virtualized `listbox` that keeps focus and points at the active row with
 * `aria-activedescendant`: the arrow keys, Home and End move it; Enter or a double-click calls
 * `onOpenEntry`. A click selects a row and leaves focus on the listbox. Needs a `FileSystemProvider`, so
 * it is not part of `@scope/react/renderers`.
 *
 * @example
 * ```tsx
 * const { default: DirectoryViewer } = await directoryRenderer.load();
 * ```
 */
export default function DirectoryViewer(props: RendererProps): React.JSX.Element {
  const { entry, onOpenEntry, onError, className, classNames } = props;
  const { children, status } = useFolderListing(entry.path, onError);
  return (
    <div {...partProps('dir-viewer', classNames, className)} data-status={statusAttribute(status)}>
      <div {...partProps('dir-header', classNames)}>
        <span {...partProps('dir-name', classNames)}>Name</span>
        <span {...partProps('dir-size', classNames)}>Size</span>
        <span {...partProps('dir-modified', classNames)}>Modified</span>
      </div>
      {status === 'loaded' && children.length === 0 && (
        <p {...partProps('dir-empty', classNames)}>This folder is empty.</p>
      )}
      <DirectoryList
        entries={children}
        label={entry.path === '' ? 'Contents of the workspace root' : `Contents of ${entry.path}`}
        onOpenEntry={onOpenEntry}
        classNames={classNames}
      />
    </div>
  );
}
