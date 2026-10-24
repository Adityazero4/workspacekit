import type { VisibleRowIndex } from '@workspacekit/core';

/**
 * The type-ahead buffer: the characters typed so far and when the last one arrived.
 *
 * @example
 * ```ts
 * let buffer: TypeaheadState | null = null;
 * ```
 */
export interface TypeaheadState {
  text: string;
  /** Timestamp of the last key, in the same clock the caller passes as `now`. */
  lastKeyAt: number;
}

const RESET_MS = 500;

/**
 * Appends `char` to the buffer, starting over when the last key was more than 500 ms ago.
 *
 * @example
 * ```ts
 * buffer = typeaheadStep(buffer, event.key, performance.now());
 * ```
 */
export function typeaheadStep(state: TypeaheadState | null, char: string, now: number): TypeaheadState {
  const continues = state !== null && now - state.lastKeyAt <= RESET_MS;
  return { text: continues ? state.text + char : char, lastKeyAt: now };
}

const wrapIndex = (index: number, count: number): number => ((index % count) + count) % count;
const foldForMatching = (text: string): string => text.normalize('NFC').toLowerCase();

/**
 * The next visible row whose name starts with `text` (case- and NFC-insensitive), wrapping past the end; -1
 * when none. One character, or one character repeated, searches after `current` (so repeats cycle through
 * matches); a longer prefix also accepts `current` itself, so typing on keeps the row it already found.
 *
 * @param current The focused row's index, or -1 to search from the top.
 * @returns The matching row's index, or -1 when no visible row matches.
 *
 * @example
 * ```ts
 * const i = findTypeahead(index, index.indexOf(focusedPath), buffer.text);
 * if (i >= 0) focus(index.rowAt(i).path);
 * ```
 */
export function findTypeahead(index: VisibleRowIndex, current: number, text: string): number {
  const chars = [...foldForMatching(text)];
  const isRepeatedChar = chars.every((char) => char === chars[0]);
  const prefix = isRepeatedChar ? chars[0]! : chars.join('');
  const rowCount = index.count;
  if (rowCount === 0) return -1;
  for (let offset = isRepeatedChar ? 1 : 0; offset <= rowCount; offset++) {
    const candidate = wrapIndex(current + offset, rowCount);
    if (foldForMatching(index.rowAt(candidate).entry.name).startsWith(prefix)) return candidate;
  }
  return -1;
}
