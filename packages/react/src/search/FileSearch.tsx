'use client';
import { parentPath, toFsError, type Entry } from '@scope/core';
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { partProps } from '../cx';
import type { ClassNames } from '../parts';
import { useFileSystem, type FileSystemContext } from '../provider/hooks';
import { highlightRanges } from './highlight';
import { useFileSearch, type FileSearchStatus } from './useFileSearch';

/**
 * Props of `FileSearch`.
 *
 * @example
 * ```tsx
 * const props: FileSearchProps = { placeholder: 'Find a file', onOpenFile: (entry) => openTab(entry.path) };
 * ```
 */
export interface FileSearchProps {
  /** Class of the root element (the `search` part). */
  className?: string;
  classNames?: ClassNames;
  /** Default `'Search files'`. */
  placeholder?: string;
  /** Called after a file result is revealed in the tree. */
  onOpenFile?: (entry: Entry) => void;
}

const ESTIMATED_OPTION_HEIGHT = 32;
const OPTIONS_IN_FIRST_PAINT = 8;
const OVERSCAN = 4;

const announcementFor = (status: FileSearchStatus, count: number): string => {
  if (status === 'error') return 'Search failed';
  if (status !== 'done') return '';
  if (count === 0) return 'No results';
  return count === 1 ? '1 result' : `${count} results`;
};

function useAnnouncementKeptWhileSearching(status: FileSearchStatus, count: number): string {
  const announcement = announcementFor(status, count);
  const [lastAnnounced, setLastAnnounced] = useState(announcement);
  if (status !== 'searching' && announcement !== lastAnnounced) setLastAnnounced(announcement);
  return status === 'searching' ? lastAnnounced : announcement;
}

function revealResult(fs: FileSystemContext, entry: Entry, onOpenFile: FileSearchProps['onOpenFile']): void {
  fs.reveal(entry.path, { flash: true, expand: true }).then(
    () => {
      if (entry.kind === 'file') onOpenFile?.(entry);
    },
    (thrown: unknown) => {
      const error = toFsError(thrown);
      if (error.kind !== 'cancelled') fs.notify({ kind: 'error', message: error.message, error });
    },
  );
}

const nextActiveIndex = (activeIndex: number, step: 1 | -1, count: number): number => {
  if (activeIndex < 0) return step === 1 ? 0 : count - 1;
  return (activeIndex + step + count) % count;
};

/**
 * A search box over the nearest provider's adapter, following the WAI-ARIA combobox-with-listbox pattern: the
 * input owns focus, ArrowDown and ArrowUp move the active result (wrapping), Enter or a click reveals it in
 * the tree (see `FileSystemContext.reveal`), and Escape clears the query. A file result is then passed to
 * `onOpenFile`; a folder result is expanded as well. The list collapses while the input does not have focus
 * (such as after a reveal moved focus to the tree) and opens again when it gets focus back.
 *
 * The results list is virtualized and shows each name, with the matches in `<mark
 * data-fs-part="search-match">` (ignoring case and Unicode normalization), and its folder path; rows are
 * measured, so they grow with the font size. A polite live region, present from the first render, announces
 * the count and keeps the last announcement while the next search runs. Typing searches after a 200 ms pause
 * (see `useFileSearch`). Renders nothing when the adapter has no `search`. Works anywhere under the provider,
 * such as next to the `FileTree`.
 *
 * @example
 * ```tsx
 * <FileSystemProvider adapter={adapter}>
 *   <FileSearch onOpenFile={(entry) => openTab(entry.path)} />
 *   <FileTree style={{ height: 400 }} />
 * </FileSystemProvider>
 * ```
 */
export function FileSearch(props: FileSearchProps): React.JSX.Element | null {
  const { className, classNames, onOpenFile } = props;
  const fs = useFileSystem();
  const search = useFileSearch();
  const { results } = search;
  const listboxId = useId();
  const [active, setActive] = useState({ results, index: -1 });
  const activeIndex = active.results === results ? active.index : -1;
  const [inputHasFocus, setInputHasFocus] = useState(false);
  const announcement = useAnnouncementKeptWhileSearching(search.status, results.length);
  const viewport = useRef<HTMLDivElement>(null);
  const resultWindow = useResultWindow(results.length, activeIndex, viewport);
  if (search.status === 'unsupported') return null;

  const optionId = (index: number): string => `${listboxId}-option-${index}`;
  const hasResults = results.length > 0;
  const isOpen = hasResults && inputHasFocus;
  const moveActive = (step: 1 | -1): void => {
    if (!isOpen) return;
    const index = nextActiveIndex(activeIndex, step, results.length);
    setActive({ results, index });
    resultWindow.scrollToIndex(index);
  };
  const activeResult = isOpen ? results[activeIndex] : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') moveActive(event.key === 'ArrowDown' ? 1 : -1);
    else if (event.key === 'Enter' && activeResult) revealResult(fs, activeResult, onOpenFile);
    else if (event.key === 'Escape' && search.query !== '') search.setQuery('');
    else return;
    event.preventDefault();
  };
  const highlightQuery = search.query.trim();

  return (
    <div {...partProps('search', classNames, className)}>
      <input
        {...partProps('search-input', classNames)}
        role="combobox"
        aria-label="Search files"
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder ?? 'Search files'}
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setInputHasFocus(true)}
        onBlur={() => setInputHasFocus(false)}
      />
      <p {...partProps('search-status', classNames)} role="status" aria-live="polite">
        {announcement}
      </p>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the mousedown only keeps focus in the combobox input; the options are reached through it */}
      <div
        ref={viewport}
        {...partProps('search-viewport', classNames)}
        hidden={!isOpen}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div
          {...partProps('search-results', classNames)}
          id={listboxId}
          role="listbox"
          aria-label="Search results"
          style={{ height: resultWindow.totalSize }}
        >
          {resultWindow.items.map((item) => {
            const entry = results[item.index]!;
            const isActive = item.index === activeIndex;
            return (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the combobox input handles the keys and points at the active option with aria-activedescendant
              <div
                key={entry.path}
                ref={resultWindow.measureElement}
                data-index={item.index}
                {...partProps('search-result', classNames)}
                id={optionId(item.index)}
                role="option"
                tabIndex={-1}
                aria-selected={isActive}
                aria-setsize={results.length}
                aria-posinset={item.index + 1}
                data-selected={isActive ? '' : undefined}
                style={{ transform: `translateY(${item.start}px)` }}
                onClick={() => revealResult(fs, entry, onOpenFile)}
              >
                <span {...partProps('search-result-name', classNames)}>
                  <HighlightedName name={entry.name} query={highlightQuery} classNames={classNames} />
                </span>
                <span {...partProps('search-result-path', classNames)}>{parentPath(entry.path)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HighlightedName(props: { name: string; query: string; classNames?: ClassNames }): ReactNode {
  const { name, query, classNames } = props;
  const pieces: ReactNode[] = [];
  let shownUpTo = 0;
  for (const [start, end] of highlightRanges(name, query)) {
    pieces.push(name.slice(shownUpTo, start));
    pieces.push(
      <mark key={start} {...partProps('search-match', classNames)}>
        {name.slice(start, end)}
      </mark>,
    );
    shownUpTo = end;
  }
  pieces.push(name.slice(shownUpTo));
  return pieces;
}

interface ResultWindow {
  items: VirtualItem[];
  totalSize: number;
  scrollToIndex: (index: number) => void;
  measureElement: (element: Element | null) => void;
}

function useResultWindow(
  count: number,
  activeIndex: number,
  viewport: RefObject<HTMLElement | null>,
): ResultWindow {
  'use no memo';
  // eslint-disable-next-line react-hooks/incompatible-library -- 'use no memo' keeps this hook uncompiled; it returns fresh values every render
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => viewport.current,
    estimateSize: () => ESTIMATED_OPTION_HEIGHT,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: OPTIONS_IN_FIRST_PAINT * ESTIMATED_OPTION_HEIGHT },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex < 0 || indexes.includes(activeIndex)) return indexes;
      return [...indexes, activeIndex].sort((a, b) => a - b);
    },
  });
  return {
    items: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollToIndex: (index) => virtualizer.scrollToIndex(index),
    measureElement: virtualizer.measureElement,
  };
}
