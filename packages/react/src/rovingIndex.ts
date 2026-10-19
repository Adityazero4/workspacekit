'use client';

/**
 * The index a roving-tabindex row of `count` items (tabs, toolbar buttons) moves to from `current` for `key`:
 * ArrowRight and ArrowLeft wrap around, Home and End go to the ends; `undefined` for any other key.
 *
 * @example
 * ```ts
 * const target = horizontalRovingIndex(event.key, buttons.indexOf(event.currentTarget), buttons.length);
 * ```
 */
export function horizontalRovingIndex(key: string, current: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}
