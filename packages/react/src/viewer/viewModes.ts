'use client';
import { isSameOrDescendant, remapPrefix } from '@workspacekit/core';
import { createUiStore, type UiStore } from '../provider/ui-store';

/**
 * The view mode the user picked for each path (such as Preview or Source), kept in memory for the provider
 * session and never persisted.
 *
 * @example
 * ```ts
 * const mode = viewModes.get().get('README.md');
 * ```
 */
export type ViewModes = UiStore<ReadonlyMap<string, string>>;

/**
 * An empty {@link ViewModes} store.
 *
 * @example
 * ```ts
 * const viewModes = createViewModes();
 * ```
 */
export function createViewModes(): ViewModes {
  return createUiStore<ReadonlyMap<string, string>>(new Map());
}

/**
 * `modes` with `path` set to `mode`; `modes` itself when it already is.
 *
 * @example
 * ```ts
 * viewModes.set((modes) => withViewMode(modes, 'README.md', 'source'));
 * ```
 */
export function withViewMode(
  modes: ReadonlyMap<string, string>,
  path: string,
  mode: string,
): ReadonlyMap<string, string> {
  return modes.get(path) === mode ? modes : new Map(modes).set(path, mode);
}

/**
 * `modes` with every path at or below `from` moved below `to`; `modes` itself when none is.
 *
 * @example
 * ```ts
 * viewModes.set((modes) => remapViewModes(modes, 'docs', 'archive/docs'));
 * ```
 */
export function remapViewModes(
  modes: ReadonlyMap<string, string>,
  from: string,
  to: string,
): ReadonlyMap<string, string> {
  if (![...modes.keys()].some((path) => isSameOrDescendant(path, from))) return modes;
  return new Map([...modes].map(([path, mode]) => [remapPrefix(path, from, to), mode]));
}
