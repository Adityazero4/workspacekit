'use client';
import { partProps } from '@scope/react/renderer-kit';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { CellAddress } from './grid/model';
import type { SheetClassNames } from './parts';
import { isSuperseded } from './reader/client';

/**
 * Props of `SearchBar`. `find` runs the search (in the reader's worker) and resolves to the matching cells
 * in display order; `onMatch` hears the match to show.
 *
 * @example
 * ```tsx
 * const props: SearchBarProps = { find, onMatch: setActiveCell, classNames: undefined };
 * ```
 */
export interface SearchBarProps {
  find: (query: string) => Promise<CellAddress[]>;
  onMatch: (cell: CellAddress) => void;
  classNames: SheetClassNames | undefined;
}

const statusText = (query: string, matches: readonly CellAddress[] | undefined, position: number): string => {
  if (query === '' || matches === undefined) return '';
  if (matches.length === 0) return 'No matches';
  return `${position + 1} of ${matches.length}`;
};

/**
 * Finds cells in the sheet as the user types. Enter shows the next match and Shift+Enter the previous one;
 * Escape clears the search. The match count is announced in a live region. Results that arrive for a query
 * the user has since changed or cleared are dropped, so they never move the selection.
 *
 * @example
 * ```tsx
 * <SearchBar find={(query) => reader.search(0, query)} onMatch={setActiveCell} classNames={undefined} />
 * ```
 */
export function SearchBar(props: SearchBarProps): React.JSX.Element {
  const { classNames } = props;
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ query: string; cells: CellAddress[] }>();
  const [position, setPosition] = useState(0);
  const latestQueryRef = useRef('');
  const current = matches?.query === query ? matches.cells : undefined;
  const show = (cells: readonly CellAddress[], index: number): void => {
    setPosition(index);
    if (cells[index]) props.onMatch(cells[index]);
  };
  const onChange = (next: string): void => {
    setQuery(next);
    latestQueryRef.current = next;
    if (next === '') return;
    props.find(next).then(
      (cells) => {
        if (latestQueryRef.current !== next) return;
        setMatches({ query: next, cells });
        show(cells, 0);
      },
      (error: unknown) => {
        if (latestQueryRef.current === next && !isSuperseded(error)) setMatches({ query: next, cells: [] });
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') onChange('');
    if (event.key !== 'Enter' || !current || current.length === 0) return;
    event.preventDefault();
    show(current, (position + (event.shiftKey ? current.length - 1 : 1)) % current.length);
  };
  return (
    <div {...partProps('sheet-search', classNames)}>
      <input
        type="search"
        aria-label="Find in sheet"
        placeholder="Find"
        value={query}
        {...partProps('sheet-search-input', classNames)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span role="status" {...partProps('sheet-search-status', classNames)}>
        {statusText(query, current, position)}
      </span>
    </div>
  );
}
