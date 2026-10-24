'use client';
import {
  basename,
  isSameOrDescendant,
  parentPath,
  toFsError,
  type Entry,
  type FileSystemAdapter,
  type FsError,
} from '@workspacekit/core';
import { useEffect, useState } from 'react';
import { failureMessage, useFileSystem, useUiValue } from '../provider/hooks';

/**
 * Options of `useFileSearch`.
 *
 * @example
 * ```ts
 * const options: UseFileSearchOptions = { debounceMs: 300, minLength: 2 };
 * ```
 */
export interface UseFileSearchOptions {
  /** How long typing must pause before a request starts. Default 200 ms. */
  debounceMs?: number;
  /** Shorter queries (ignoring surrounding spaces) stay idle and send no request. Default 1. */
  minLength?: number;
}

/**
 * Where a search stands: `idle` (the query is too short), `searching`, `done`, `error`, or `unsupported` (the
 * adapter has no `search`).
 *
 * @example
 * ```ts
 * const busy = (status: FileSearchStatus): boolean => status === 'searching';
 * ```
 */
export type FileSearchStatus = 'idle' | 'searching' | 'done' | 'error' | 'unsupported';

/**
 * What `useFileSearch` returns.
 *
 * @example
 * ```ts
 * const { query, setQuery, results, status }: FileSearchState = useFileSearch();
 * ```
 */
export interface FileSearchState {
  query: string;
  setQuery: (query: string) => void;
  /**
   * The entries found below the provider root; while `searching`, the previous answer's (empty after an
   * error).
   */
  results: readonly Entry[];
  status: FileSearchStatus;
  /** The failure behind `status: 'error'`. */
  error?: FsError;
}

interface SearchRequest {
  searchText: string;
  adapter: FileSystemAdapter;
}

interface Outcome {
  entries: readonly Entry[];
  error?: FsError;
  isStale: boolean;
}

interface ResultFilter {
  root: string;
  hiddenNamesLeftOut: ReadonlySet<string> | null;
}

const NO_RESULTS: readonly Entry[] = [];

const isSameRequest = (first: SearchRequest, second: SearchRequest): boolean =>
  first.searchText === second.searchText && first.adapter === second.adapter;

/**
 * Whether `path`, or a folder between it and `root`, has one of `hiddenNames` as its name.
 *
 * @example
 * ```ts
 * isUnderAHiddenName('node_modules/x/index.js', '', new Set(['node_modules'])); // true
 * ```
 */
export function isUnderAHiddenName(path: string, root: string, hiddenNames: ReadonlySet<string>): boolean {
  for (let ancestor = path; ancestor !== root && ancestor !== ''; ancestor = parentPath(ancestor)) {
    if (hiddenNames.has(basename(ancestor))) return true;
  }
  return false;
}

function shownResults(entries: readonly Entry[], filter: ResultFilter): readonly Entry[] {
  const { root, hiddenNamesLeftOut } = filter;
  return entries.filter(
    (entry) =>
      entry.path !== root &&
      isSameOrDescendant(entry.path, root) &&
      !(hiddenNamesLeftOut && isUnderAHiddenName(entry.path, root, hiddenNamesLeftOut)),
  );
}

const haveTheSameEntries = (first: readonly Entry[], second: readonly Entry[]): boolean =>
  first.length === second.length && first.every((entry, at) => entry === second[at]);

interface FilteredResults extends ResultFilter {
  entries: readonly Entry[];
  results: readonly Entry[];
}

function useResultsFilteredAtRender(entries: readonly Entry[], filter: ResultFilter): readonly Entry[] {
  const [filtered, setFiltered] = useState<FilteredResults>(() => ({
    ...filter,
    entries,
    results: shownResults(entries, filter),
  }));
  const inputsUnchanged =
    filtered.entries === entries &&
    filtered.root === filter.root &&
    filtered.hiddenNamesLeftOut === filter.hiddenNamesLeftOut;
  if (inputsUnchanged) return filtered.results;
  const refiltered = shownResults(entries, filter);
  const results = haveTheSameEntries(refiltered, filtered.results) ? filtered.results : refiltered;
  setFiltered({ ...filter, entries, results });
  return results;
}

function useSearchRequests(
  request: SearchRequest,
  debounceMs: number,
  onOutcome: (outcome: Outcome) => void,
): void {
  const { notify } = useFileSystem();
  const { searchText, adapter } = request;
  useEffect(() => {
    if (!adapter.search || searchText === '') return;
    const aborter = new AbortController();
    const timer = setTimeout(() => {
      adapter.search!(searchText, { signal: aborter.signal }).then(
        (entries) => {
          if (!aborter.signal.aborted) onOutcome({ entries, isStale: false });
        },
        (thrown: unknown) => {
          const error = toFsError(thrown);
          if (aborter.signal.aborted || error.kind === 'cancelled') return;
          onOutcome({ entries: NO_RESULTS, error, isStale: false });
          notify({ kind: 'error', message: failureMessage('Search failed', error), error });
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      aborter.abort();
    };
  }, [adapter, notify, searchText, debounceMs, onOutcome]);
}

function useOutcomeMarkedStaleWhenTheRequestChanges(
  request: SearchRequest,
): [Outcome | null, (outcome: Outcome) => void] {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [requested, setRequested] = useState(request);
  if (!isSameRequest(requested, request)) {
    setRequested(request);
    if (outcome && !outcome.isStale) setOutcome({ ...outcome, isStale: true });
  }
  return [outcome, setOutcome];
}

/**
 * Searches the nearest provider's adapter as the query changes. A request starts once typing pauses for
 * `debounceMs`, receives an `AbortSignal`, and is aborted as soon as the query changes again (or the
 * component unmounts), so an older answer never replaces a newer one. Until the new answer lands, the status
 * is `searching` and `results` keeps the previous answer. A failed search (not an aborted one) sets `status:
 * 'error'` and goes to the provider's `onNotify` and `onError`. Results outside the provider root are left
 * out, and so are results under a hidden name (see the provider's `hidden`) while Show hidden is off; that
 * filter applies at render, so toggling Show hidden takes effect at once without a new request. `results`
 * keeps its identity while its entries do not change.
 *
 * @example
 * ```tsx
 * const { query, setQuery, results, status } = useFileSearch({ minLength: 2 });
 * <input
 *   value={query}
 *   onChange={(event) => setQuery(event.target.value)}
 *   aria-busy={status === 'searching'}
 * />
 * ```
 */
export function useFileSearch(options?: UseFileSearchOptions): FileSearchState {
  const debounceMs = options?.debounceMs ?? 200;
  const minLength = options?.minLength ?? 1;
  const fs = useFileSystem();
  const showHidden = useUiValue(fs.showHidden);
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const request: SearchRequest = {
    searchText: trimmed.length >= minLength ? trimmed : '',
    adapter: fs.adapter,
  };
  const [outcome, setOutcome] = useOutcomeMarkedStaleWhenTheRequestChanges(request);
  useSearchRequests(request, debounceMs, setOutcome);
  const results = useResultsFilteredAtRender(outcome?.entries ?? NO_RESULTS, {
    root: fs.root,
    hiddenNamesLeftOut: showHidden ? null : fs.hiddenNames,
  });

  if (!fs.adapter.search) return { query, setQuery, results: NO_RESULTS, status: 'unsupported' };
  if (request.searchText === '') return { query, setQuery, results: NO_RESULTS, status: 'idle' };
  if (!outcome || outcome.isStale) return { query, setQuery, results, status: 'searching' };
  if (outcome.error) return { query, setQuery, results: NO_RESULTS, status: 'error', error: outcome.error };
  return { query, setQuery, results, status: 'done' };
}
