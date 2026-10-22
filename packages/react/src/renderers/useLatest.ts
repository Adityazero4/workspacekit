'use client';
import { useEffect, useRef, type RefObject } from 'react';

/**
 * A ref that holds the latest `value` after every commit. Effects and callbacks read the latest callback
 * prop through it without listing the prop as a dependency, so an inline callback whose identity changes on
 * every render does not re-run them.
 *
 * @example
 * ```ts
 * const reportError = useLatest(props.onError);
 * useEffect(() => load(src).catch((error) => reportError.current?.(error)), [src]);
 * ```
 */
export function useLatest<T>(value: T): RefObject<T> {
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  return latest;
}
