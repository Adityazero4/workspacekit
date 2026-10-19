'use client';
import { isSameOrDescendant, remapPrefix } from '@scope/core';
import { useSyncExternalStore } from 'react';
import { createUiStore, type UiStore } from '../provider/ui-store';
import type { RovingFocusController } from './rovingFocus';

/**
 * One inline rename in progress. After a failed rename it reopens with the name the user had typed, taking
 * focus only when nothing else has claimed it.
 *
 * @example
 * ```ts
 * const session: RenameSession = { path: 'src/a.ts', draft: 'b.ts', takesFocus: false };
 * ```
 */
export interface RenameSession {
  path: string;
  /** The input's starting value instead of the entry's name. */
  draft?: string;
  /** Whether the input focuses itself when it opens. */
  takesFocus: boolean;
  /** The text range to select when the input opens, instead of the stem. */
  selection?: { start: number; end: number };
}

/**
 * A tree's inline rename state and commands. Identity-stable for the life of the tree, so memoized rows can
 * subscribe to their own session without re-rendering when another row starts renaming.
 *
 * @example
 * ```ts
 * inlineRename.start('src/a.ts');
 * inlineRename.end('src/b.ts');
 * ```
 */
export interface InlineRename {
  /** The current session, or `null`. At most one row renames at a time. */
  session: UiStore<RenameSession | null>;
  /**
   * Starts renaming `path`, replacing any other session. If `path` is already being renamed, its open input
   * takes focus and keeps what was typed. `reopen` restores a failed attempt.
   */
  start: (path: string, reopen?: { draft: string; takesFocus: boolean }) => void;
  /**
   * Ends the session, then focuses `focusPath`'s row once it is visible (`null` leaves focus where it is).
   */
  end: (focusPath: string | null) => void;
  /** Withdraws the focus request an `end(focusPath)` made, when the row it waits for will not appear. */
  cancelFocus: (focusPath: string) => void;
  /**
   * Follows a move of the renaming entry or a folder above it: the session moves to the new path, and the row
   * that remounts there reopens the input with what was typed, the same selection, and focus if the input had
   * it.
   */
  followMove: (from: string, to: string) => void;
  /**
   * Registers the open rename input, so a move can carry what was typed to the remounted row. Returns the
   * detach.
   */
  attachInput: (input: HTMLInputElement) => () => void;
}

/**
 * Creates the inline rename state of one tree, focusing rows through its roving focus.
 *
 * @example
 * ```ts
 * const [inlineRename] = useState(() => createInlineRename(rovingFocus.controller));
 * ```
 */
export function createInlineRename(
  focus: Pick<RovingFocusController, 'focusPathOnceVisible' | 'cancelFocusRequest'>,
): InlineRename {
  const session = createUiStore<RenameSession | null>(null);
  let openInput: HTMLInputElement | null = null;
  return {
    session,
    start: (path, reopen) =>
      session.set((current) =>
        current?.path === path
          ? { ...current, takesFocus: true }
          : { path, draft: reopen?.draft, takesFocus: reopen?.takesFocus ?? true },
      ),
    end: (focusPath) => {
      session.set(null);
      if (focusPath !== null) focus.focusPathOnceVisible(focusPath);
    },
    cancelFocus: focus.cancelFocusRequest,
    followMove: (from, to) =>
      session.set((current) =>
        current && isSameOrDescendant(current.path, from)
          ? { ...current, ...stateOfTheOpenInput(openInput), path: remapPrefix(current.path, from, to) }
          : current,
      ),
    attachInput: (input) => {
      openInput = input;
      return () => {
        if (openInput === input) openInput = null;
      };
    },
  };
}

function stateOfTheOpenInput(input: HTMLInputElement | null): Partial<RenameSession> {
  if (!input) return {};
  return {
    draft: input.value,
    takesFocus: input.ownerDocument.activeElement === input,
    selection: { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 },
  };
}

/**
 * `path`'s rename session, or `null`; re-renders only when `path` starts or stops renaming.
 *
 * @example
 * ```tsx
 * const session = useRenameSession(inlineRename, row.path);
 * ```
 */
export function useRenameSession(inlineRename: InlineRename, path: string): RenameSession | null {
  const { session } = inlineRename;
  const read = (): RenameSession | null => {
    const current = session.get();
    return current?.path === path ? current : null;
  };
  return useSyncExternalStore(session.subscribe, read, read);
}
